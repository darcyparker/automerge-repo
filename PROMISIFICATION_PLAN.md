# Promisification & Abort-Signal Plan

Branch: `darcy/promisifications` (on top of `main`)
Owner: Darcy
Status: Phase 0 complete; Phase 1 (add `changeAsync()` and async siblings) not started

## Background

This branch has two layers:

- **Phase 0** (done): abort-signal hygiene across storage I/O and the
  network / synchronizer boundary. Cleaner cancellation semantics, signal
  reasons propagated, shared lifecycle promises explicitly marked
  non-abortable. This was prerequisite cleanup, not the goal.
- **Phase 1** (this design): give `DocHandle.change()` and friends
  awaitable async siblings (`changeAsync`, `whenSaved`, `createAsync`, …)
  that resolve once the change has been durably written to storage.

**Why promisify `change()`?**

A change held only in memory is one crash away from being lost. Today's
`change()` returns immediately; the storage save runs in the background
(throttled), and the caller has no way to know whether their change
survived. Network sync is not a substitute — re-sync recovers from
network gaps, but it cannot recover changes that were never persisted
locally on either side. **A `change()` that doesn't guarantee persistence
is an incomplete primitive.** That's the gap Phase 1 closes.

A secondary motivation: the signals for "it landed" already exist today,
but they reach callers as a stream of EventEmitter events spread across
three subsystems. Subscribing across that chain in user code is the kind
of glue you write once, get wrong, and never touch again — collapsing
it into a single `await` is a real ergonomic win.

Phase 0 was the unglamorous part: making sure that where async
coordination already exists in the repo, it cancels cleanly, propagates
`signal.reason`, and doesn't strand promises on shared lifecycle events.
The 5 cherry-picked "AbortOptions everywhere" commits from the abandoned branch
`darcy/asyncCoordinationImprovements` were replaced with a smaller, more
discriminating set that adds abort support **only where it does real work**
(storage I/O) and explicitly documents why other methods don't take it.

This document records what's done in Phase 0, the design for Phase 1, and
the boundary of what's deferred or out of scope.

## Guiding principles

- **Storage is the durability boundary; network is best-effort.** A `Repo` has
  at most one storage adapter and zero-or-more network adapters. Persistence to local
  storage is the strong "the change won't be lost" signal; broadcasting to
  peers is eventual and doesn't carry the same durability meaning.
- **Add `AbortSignal` where work is real** — storage I/O, long network sends.
  Skip it on lifecycle "wait-for-state" methods.
- **Never share an abortable promise across callers.** Shared/memoized promises
  must not be abortable, because one caller's abort poisons the others.
- **`connect()` kicks off, `whenReady()` waits.** Don't merge these — it
  creates ambiguity about where the asyncness lives.
- **Receiving a wire message is not a cancellable RPC.** Drop a message → sync
  hole.
- **Prefer external race patterns** (`Promise.race([p, abortPromise])`,
  `withAbort(p, signal)`) for cancelling shared promises locally without
  poisoning others.
- **Use `signal.throwIfAborted()` as the idiomatic check in async methods.**
  Propagates `signal.reason` (including custom reasons), short-circuits the
  already-aborted case, becomes a rejection naturally inside an `async`
  function.
- **Promisify only when the natural completion signal exists.** Events that
  fire reliably after the work completes are good resolution points.

The abort-related rules (2 through 6) are documented for contributors in
[`packages/automerge-repo/dev-docs/abort-patterns.md`](packages/automerge-repo/dev-docs/abort-patterns.md).

---

# Phase 0 — abort-signal cleanup (this branch)

## Status: done

Branch is currently 8 commits ahead of `main`. In order from oldest to newest:

1. **rename `abortable()` → `withAbort()` and preserve `signal.reason`** —
   file renamed (`abortable.ts` → `withAbort.ts`), function reimplemented
   (`Promise.race` + manual reject capture, since Node 20 lacks
   `Promise.withResolvers`), `signal.reason` propagated on both fast and race
   paths, input loosened to `PromiseLike<T>`, `AbortError` gets
   `Error.captureStackTrace` and spec/MDN `@see` links.
2. **docs: add `dev-docs/abort-patterns.md` and link from code** —
   cross-cutting guidance (when to accept `AbortSignal`; the
   sharing rule; race externally; `withAbort` vs raw `Promise.race`; the
   `throwIfAborted()` idiom with where-to-check rules; `AbortError` /
   `signal.reason` semantics). Pointers from `withAbort.ts`,
   `AbortOptions` `@remarks`, and `CONTRIBUTING.md`.
3. **add optional `AbortOptions` to storage I/O** —
   `StorageAdapterInterface`, `StorageAdapter`, `StorageSubsystem.load` /
   `loadDocData` / `loadDoc` / `loadSyncState` (NOT `id`), `DummyStorageAdapter`
   uses `signal.throwIfAborted()`. `@privateRemarks` / `@remarks` on each.
4. **document Network adapter and Synchronizer methods as intentionally not
   abortable** — `@privateRemarks` / `@remarks` on `whenReady`, `connect`,
   `receiveMessage`. Plus the **B4 fix**: abstract
   `Synchronizer.receiveMessage` is now `Promise<void> | void`, matching
   `CollectionSynchronizer`.
5. **fix unhandled connect promise rejection in
   `NetworkSubsystem.addNetworkAdapter` (B1)** — `.then(...)` returns its
   inner `connect(...)` call.
6. **propagate `signal.reason` from `Repo.find()` already-aborted fast path**
   — was `throw new AbortError()`; now `signal?.throwIfAborted()`.
   `Repo.test.ts` updated to use `isAbortErrorLike`.
7. **propagate `signal.reason` from `pause()` rejection paths** — was
   `reject(new AbortError())`; now `reject(signal.reason)`. `pause` is
   constructor-style (`new Promise<void>(...)`, not `async`), so
   `throwIfAborted()` doesn't fit — explicit `reject(signal.reason)` is the
   right shape.
8. **plumb signal through `find()` and fix continuation-after-abort in
   `#loadDocument` (B5)** — `Repo.findWithProgress` now passes `signal` into
   `#loadDocumentWithProgress`, which forwards it to `storageSubsystem.loadDoc`.
   `Repo.findClassic` similarly passes `signal` into `#loadDocument`. The
   stray `await` in `#loadDocumentWithProgress` that was masking the abort
   race was dropped. `#loadDocument`'s bare
   `await this.networkSubsystem.whenReady()` was replaced with
   `await withAbort(networkSubsystem.whenReady(), signal)` so an abort
   during the network wait throws before `handle.request()` runs (B5).

**B2** (`DummyNetworkAdapter` memoized `{promise, resolve, reject}` per signal)
and **B3** (`disconnect()` rejecting pending `whenReady()` callers) were
resolved by simply **not reintroducing** the broken cherry-picked
`DummyNetworkAdapter` rewrite.

Tests: 544 passing, 0 failing.

## Status: still to do (Phase 0)

Nothing critical remains. One deferred item:

- **`CollectionSynchronizer.onLoadSyncState`** has no signal source today
  (the sync-state load happens reactively when a peer connects). Revisit
  once `DocSynchronizer` has a clear dispose lifecycle so we can wire its
  cancellation signal into the load. Probably Phase 1 or later.

`findClassic` has no test coverage in this repo (no `findClassic` tests
exist on `main` either) — its share of the B5 fix is therefore only
verified by inspection. If you want a test, the shape would be:
construct a `Repo` with a `DummyNetworkAdapter({ startReady: false })`,
call `repo.findClassic(url, { signal })`, abort, assert the rejection is
AbortError-like, and inspect `repo.handles[documentId].state` to confirm
it didn't transition to `"requesting"`.

### Why `loadRange()` stayed an array

(Settled decision — recording for posterity, no action.) The only consumer is
[`StorageSubsystem.loadDocData`](packages/automerge-repo/src/storage/StorageSubsystem.ts),
which merges all chunks into a single `Uint8Array` via `mergeArrays`.
Streaming an `AsyncIterable<Chunk>` saves nothing here — peak memory is
unchanged. Defer until a streaming consumer actually exists (e.g. incremental
load path).

---

# Phase 1 — Async siblings for `DocHandle.change()` (and friends)

## Motivation

Today's `change()` is fire-and-forget. The caller has no way to know when
their change has actually been **durably persisted** — storage save is kicked
off via an `asyncThrottle` after the update event fires, so the caller's
`change()` returns while the save is still pending. This is the gap Phase 1
closes: an awaitable variant guarantees the change has reached the storage
adapter.

**Design choice: separate async methods.** Existing sync methods stay
unchanged; awaitable variants are new sibling methods (`changeAsync`,
`changeAtAsync`, `mergeAsync`, `createAsync`). Callers who don't need
durability await keep using `change()` / `create()` and see zero diff.
Callers who do need it opt in by calling the `Async` variant. This avoids
the back-compat surface of promisifying `change()` itself (no unhandled
rejections introduced for non-awaiting callers, no need for a `void`
opt-out convention, TS types cleanly discriminate intent at the call
site).

**Phase 1 is storage-only.** Awaiting network broadcast (i.e. "wait until
every connected peer has been sent this change") is deliberately deferred
and may not be worth implementing at all — storage durability is the
meaningful guarantee, network broadcast is best-effort eventual sync, and
"we emitted a message" is not the same as "the peer has it." See
[Future considerations: awaiting network broadcast](#awaiting-network-broadcast-deferred-doubtful-at-best)
for what a network-await design would look like and why we're skeptical it
earns its complexity.

The chain we care about — same for both the existing sync `change()` and the
new `changeAsync()`:

```
user calls handle.change(cb)  // or handle.changeAsync(cb)
  └─ xstate machine UPDATE
       └─ DocHandle emits "heads-changed" + "change"
            └─ Repo's #saveFn (asyncThrottle → StorageSubsystem.saveDoc)
                  └─ StorageSubsystem emits "doc-saved" / "doc-compacted"
```

`changeAsync()` waits for the final `doc-saved` step before resolving;
`change()` returns immediately after `#sendUpdate` and lets the save
happen in the background as it does today.

Subscribing across this chain in user code is real callback hell. We want:

```ts
// Existing sync API — unchanged. Fire-and-forget; storage save throttled.
handle.change(d => {
  d.foo = "bar"
})

// New async sibling — resolves once storage has accepted the change.
const after = await handle.changeAsync(d => {
  d.foo = "bar"
})
// `after` is the document's post-change UrlHeads — see
// "Why return heads?" below for what callers can do with them.
```

## Design

### Contract

`changeAsync()` returns `Promise<UrlHeads>` — the document's heads after the
change has landed in memory and storage has persisted a save covering them.
Specifically: the `StorageSubsystem` has emitted a `doc-saved` (or
`doc-compacted`) event whose `savedHeads` covers the change's target heads;
the Promise resolves with those target heads.

For no-op changes (callback didn't mutate the doc), the Promise resolves
immediately with the unchanged heads — callers can detect a no-op by
comparing against the heads captured before the call.

If the repo has no storage adapter, the Promise resolves immediately (with
the new heads) after the in-memory `A.change` step — there is no durability
to wait on.

The existing sync `change()` is unchanged: callers continue to call it
fire-and-forget, storage save is throttled as today, and storage errors
continue to surface via `doc-metrics` (no new error surface on that path).
`changeAsync()` is a new method on `DocHandle`, not a replacement.

**Why return heads?** Two reasons.

1. **Undo/redo and history.** Given any two head states, callers can compute
   the patches between them via `A.diff(doc, before, after)`. That makes
   `(before-heads, after-heads)` the canonical checkpoint for undo/redo,
   change logs, and similar features without forcing this layer to commit
   to a patch shape in the Promise contract.
2. **Cheap and lossless.** Heads are a small array of hashes; patches can be
   large for big changes. Returning heads keeps the contract light, and
   patches are derivable on demand. No information is lost — any
   patch-shape we could embed in the Promise is reconstructible from heads.

(Note: `A.ChangeOptions.patchCallback` is still forwarded to `A.change`
since `ChangeOptions` is passed through, but it becomes largely redundant
with heads-return + `A.diff`. The only thing the callback offers that the
returned heads don't is patches _synchronously inside_ `A.change` — rare
and exotic for automerge-repo callers, who typically want patches after
the change has settled anyway.)

**Example: deriving patches from the returned heads.**

```ts
// Capture pre-change heads synchronously if you'll need them later
// (e.g. for an undo stack).
const before = handle.heads()

// changeAsync() resolves with the post-change heads once storage has them.
const after = await handle.changeAsync(d => {
  d.title = "renamed"
})

// Forward patches: what changed.
const patches = A.diff(handle.docSync(), before, after)

// Inverse patches (for an undo): just swap the head arguments.
const inverse = A.diff(handle.docSync(), after, before)
```

`A.diff` requires a doc that contains both head sets in its history; the
handle's current doc always satisfies this for heads it itself produced,
even if the doc has advanced further since the `changeAsync()` call.

**Rejection cases:**

- Synchronous validation (`!isReady()`, `#fixedHeads`) — throws before any
  work happens.
- Storage error during the awaited save — surfaces as a rejection because
  durability is the whole point of awaiting.
- `options.signal` aborts — rejects with `signal.reason`, but underlying
  side-effects still proceed. `signal` cancels only the `await`. The change
  is already in memory and there's no way to "un-change" it once `A.change`
  ran.

Network broadcast is **not** part of the resolution criteria. Sync to peers
proceeds independently via the existing `DocSynchronizer` event chain and
will happen on its own schedule; the awaited Promise does not wait on it.
See [Future considerations](#awaiting-network-broadcast-deferred-doubtful-at-best)
for the deferred design.

Optional second arg:

```ts
type ChangeOptions<T> = A.ChangeOptions<T> & {
  signal?: AbortSignal // abort the await, not the change itself
}
```

No `awaitFor` flag in Phase 1 — there is only one thing to wait on (storage).
If a network-await mode is ever added, it would arrive as a new option here.

### Events we need

Existing on `StorageSubsystem`:

- `StorageSubsystem.on("doc-saved", { documentId, durationMillis, sinceHeads, savedHeads })` ✓
- `StorageSubsystem.on("doc-compacted", { documentId, durationMillis, savedHeads })` ✓
- `StorageSubsystem.on("document-loaded", { documentId, durationMillis, numOps, numChanges })` ✓ (not used by `#waitForStored` but listed for completeness)

⚠️ **Both `doc-saved` and `doc-compacted` are emitted _before_ the actual
`storageAdapter.save()` I/O completes** ([StorageSubsystem.ts:277 vs
:287](packages/automerge-repo/src/storage/StorageSubsystem.ts#L277-L300),
[:316 vs :331](packages/automerge-repo/src/storage/StorageSubsystem.ts#L305-L344)).
So a listener that resolves on `doc-saved` today resolves on "Automerge
encoded the binary," not on "storage adapter accepted it." Phase 1 moves
the emission to after the I/O completes — see
[Storage error event design](#storage-error-event-design).

Needed but doesn't exist yet: a storage **failure** event. Today storage
errors propagate out of `StorageSubsystem.saveDoc`, but
`Repo.#saveFn`'s `void`-call ([Repo.ts:205](packages/automerge-repo/src/Repo.ts#L191-L209))
silently drops them. No log, no event, no metric. Phase 1 adds
`doc-failed-save` — see
[Storage error event design](#storage-error-event-design) for the design.

Bridged through `Repo` → `DocHandle`:

- `DocHandle.on("storage-saved", { savedHeads })` — Repo subscribes to
  `StorageSubsystem` `doc-saved` / `doc-compacted` (after the timing fix
  above) and re-emits per-handle.
- `DocHandle.on("storage-failed", { error, targetHeads })` — same, for the
  new failure event.

No new sync/peer events in Phase 1. The `doc-synced` / `peer-removed`
synchronizer events sketched in earlier drafts are moved to
[Future considerations: awaiting network broadcast](#awaiting-network-broadcast-deferred-doubtful-at-best).

### Implementation sketch

A note on which primitives we reuse vs. add. The `DocHandle` already runs
an XState v5 machine, and XState provides `waitFor(actor, predicate)` for
state-machine state transitions — `whenReady()` is already built on it via
the existing `#statePromise()` helper
([DocHandle.ts:200-213](packages/automerge-repo/src/DocHandle.ts#L200-L213)).
We don't reinvent that. But **storage durability is not a state-machine
state** — the DocHandle machine has no `saving` / `saved` transitions; it
tracks document readiness (loading, ready, unavailable, deleted), nothing
about persistence. Storage success and failure flow through EventEmitter
events from `StorageSubsystem` (bridged through `Repo` → `DocHandle`).
`#waitForStored` is therefore an event-driven primitive, not an XState
one — consistent with how `heads-changed` and the other storage-adjacent
signals already cross subsystem boundaries.

So the split is:

- **State-machine transitions** (`whenReady`) → XState `waitFor` via
  `#statePromise()`. Already present; unchanged.
- **Event-driven coordination** (`#waitForStored`, the foundation for
  `changeAsync` / `whenSaved` / `createAsync`) → new this phase, built on
  the storage events the
  [Storage error event design](#storage-error-event-design) introduces.

```ts
async changeAsync(
  callback: A.ChangeFn<T>,
  options: A.ChangeOptions<T> & { signal?: AbortSignal } = {},
): Promise<UrlHeads> {
  if (!this.isReady()) throw new Error(...)
  if (this.#fixedHeads) throw new Error(...)

  const beforeHeads = encodeHeads(A.getHeads(this.#doc))
  this.#sendUpdate(doc => A.change(doc, options, callback))
  const targetHeads = encodeHeads(A.getHeads(this.#doc))

  // No-op change (empty/idempotent callback): resolve with unchanged heads.
  if (headsAreSame(beforeHeads, targetHeads)) return targetHeads

  await this.#waitForStored(targetHeads, options.signal)
  return targetHeads
}
```

`#waitForStored(heads, signal)`:

- **Already-saved fast path.** Before subscribing to events, check
  `StorageSubsystem`'s last-saved-heads for this doc
  (`#storedHeads.lastSavedHeads(documentId)`). If those already cover
  `heads` (heads-include), resolve immediately — no event will fire,
  because no save needs to happen. This is the common path for
  `whenSaved()` called on a handle loaded from storage with no
  subsequent in-memory edits.
- Otherwise listen for `storage-saved` events whose `savedHeads` covers
  `heads` (Automerge's `A.encodeHeads`/heads-include semantics).
- Resolves on the first matching event.
- Rejects on `storage-failed` covering the relevant doc (storage durability
  is the contract).
- Rejects if `signal` aborts (propagates `signal.reason`).
- If the repo has no storage subsystem, resolves immediately.

Subscribe-before-check is important: the listener must be attached before
the fast-path check, then the fast-path check decides whether to resolve
immediately or wait. Otherwise a save that completes between the check
and the subscribe is missed.

### `whenSaved()` — companion durability await

Not every "wait for storage" caller issued the change themselves. The
canonical example: a request handler calls `repo.create(data)` (which
internally invokes `handle.update()` synchronously, kicking off a throttled
save), then needs to confirm storage has the change before responding. The
sync `create()` returns a `DocHandle`, not a `Promise`.

`whenSaved()` exposes the same `#waitForStored` machinery for that caller:

```ts
handle.whenSaved(options?: { signal?: AbortSignal }): Promise<void>
```

Resolves when the storage adapter has confirmed a save covering the handle's
current heads at call time. Same rejection semantics as `changeAsync()`'s
storage wait: storage error → reject, signal abort → reject with
`signal.reason`, no storage adapter → resolves immediately.

Implementation is essentially:

```ts
whenSaved(options: { signal?: AbortSignal } = {}): Promise<void> {
  if (!this.isReady()) throw new Error(...)
  return this.#waitForStored(A.getHeads(this.#doc), options.signal)
}
```

The `isReady()` guard mirrors today's `change()` (see Decision #2). Same
machinery as `changeAsync()`; no new event plumbing required. Belongs in
Phase 1 because the `#waitForStored` primitive lands here and
`whenSaved()` is its most useful standalone application.

### Promisifying `Repo.create()`

Today `Repo.create()` is synchronous: it constructs a `DocHandle`, kicks off
the initial save through `handle.update()` → `asyncThrottle`, and returns the
handle immediately. The caller has the handle but no signal that storage has
the initial state.

With `whenSaved()` available, the caller can already write:

```ts
const handle = repo.create(data)
await handle.whenSaved()
```

`createAsync()` is the sibling async method that combines those into one
expression and provides a "give me the handle only once it's safe"
affordance, mirroring the `change()` / `changeAsync()` pattern:

```ts
// Sync (existing) — unchanged
create<T>(initialValue?: T, options?: RepoCreateOptions): DocHandle<T>

// Async (new) — resolves once storage has the initial heads
createAsync<T>(
  initialValue?: T,
  options?: RepoCreateOptions & { signal?: AbortSignal }
): Promise<DocHandle<T>>
```

`createAsync` is essentially `create` + `await handle.whenSaved()`, with
`signal` plumbed through. Rejects on storage error or signal abort (same
semantics as `changeAsync()` and `whenSaved()`). If the repo has no storage
adapter, resolves with the handle as soon as it's constructed.

**Note: `create2` exists.** There's already an `@hidden` / `@experimental`
async variant at [Repo.ts:501](packages/automerge-repo/src/Repo.ts#L501)
called `create2`, returning `Promise<DocHandle<T>>`. Its async-ness is
for a different reason — it `await`s an async `idFactory` (used for
keyhive integration) — not for storage durability. Its own internal
comment flags the shape as temporary: _"This is all really in service of
wiring up keyhive and we probably need to find a nicer way to achieve
this."_ A natural follow-up is to fold the idFactory await and the
storage-durability await into a single `createAsync()`, with `create2`
either deprecated or kept as a thin `@hidden` shim. **Probably out of
scope for this branch** — keyhive integration belongs to its own owner
— but worth surfacing during code review so the eventual consolidation
isn't missed.

`#waitForStored(heads, signal)` needs to do two things: resolve when storage
durably has those heads, and reject when storage fails to save them.
Neither signal exists in the right shape today.

#### What's there today (audit findings)

- `StorageSubsystem` emits `doc-saved`, `doc-compacted`, `document-loaded` —
  all narrowly-scoped **success** events. No failure events anywhere in
  the package (only `doc-denied` exists, on the Synchronizer — unrelated,
  signals access denial).
- `doc-saved` and `doc-compacted` fire **before** the `storageAdapter.save()`
  I/O completes. They fire after the in-memory `A.saveSince` / `A.save`
  encoding step, but the actual write hasn't returned yet.
- Storage errors propagate out of `StorageSubsystem.saveDoc` (no try/catch
  except in `loadSyncState`, which catches+logs+returns undefined).
- `Repo.#saveFn` swallows storage errors via `void fn(...)` at
  [Repo.ts:191-209](packages/automerge-repo/src/Repo.ts#L191-L209) — the
  failure vanishes entirely.
- `doc-metrics` re-aggregates the three success events plus sync metrics;
  it carries no error info.
- `asyncThrottle` itself does **not** swallow rejections — they escape to
  the call site, where the `void` operator drops them.

So the design problem isn't just "what to name the error event." It's
**how to restructure the save path so success and failure are both
reliably observable, and so success actually means durable.**

#### Design options

##### Option A — Symmetric pair, emit _after_ I/O (chosen)

Restructure `#saveIncremental` and `#saveTotal` to wrap the I/O in try/catch
and emit success after, failure in catch:

```ts
// Inside #saveIncremental (similar for #saveTotal)
const start = performance.now()
const binary = A.saveSince(doc, sinceHeads)
const savedHeads = A.getHeads(doc)

if (binary && binary.length > 0) {
  const key = [documentId, "incremental", keyHash(binary)]
  try {
    await this.#storageAdapter.save(key, binary)
  } catch (error) {
    this.emit("doc-failed-save", {
      documentId,
      sinceHeads,
      targetHeads: savedHeads, // what we tried to save
      error,
    })
    throw error
  }
  // Bookkeeping: chunkInfos, headsHandle.update, etc.
  this.emit("doc-saved", {
    documentId,
    durationMillis: performance.now() - start,
    sinceHeads,
    savedHeads,
  })
}
```

Same shape for `#saveTotal` (with `doc-compacted` instead of `doc-saved`).
The failure event carries the same identification fields as the success
event so `#waitForStored` can filter the same way, plus an `error` field.

**Pros:**

- `doc-saved` now actually means durable — the durability premise of
  `#waitForStored` becomes correct.
- Error event mirrors the success event; subscribers can listen for
  either; one consistent rule across the subsystem.
- `Repo.#saveFn`'s `void`-swallow can be fixed at the same time: catch
  the throttled save's rejection and re-emit as `doc-metrics` for
  telemetry consumers who don't want to subscribe to `StorageSubsystem`
  directly.

**Cons:**

- Slight behavior change for existing `doc-saved` listeners: fires
  fractionally later (after I/O instead of after encoding). The
  `durationMillis` now includes I/O time, which is probably what
  consumers actually wanted, but worth checking if any tests/consumers
  depend on the early-fire timing.

##### Option B — Add `doc-failed-save`, leave `doc-saved` where it is

Minimal change: wrap the I/O in try/catch and emit failure on rejection.
Keep `doc-saved` firing _before_ I/O.

**Pros:** Zero behavior change for existing listeners.

**Cons:** `doc-saved` still doesn't mean durable, so `#waitForStored` can't
listen for it as its success signal. We'd need a _new_ event (e.g.
`doc-storage-settled`) for the post-I/O success state — making the surface
confusing (two near-identical success events with subtly different
timings).

##### Option C — Single `doc-save-result` discriminated event

```ts
type SaveResult =
  | { documentId; outcome: "saved"; savedHeads; sinceHeads?; durationMillis }
  | { documentId; outcome: "failed"; targetHeads; error }
```

**Pros:** Single subscription, branch on `outcome`.

**Cons:** Less ergonomic — subscribers who only care about success or only
about failure still get both and have to branch. Cuts against the existing
style (`document-loaded`, `doc-saved`, `doc-compacted` are narrowly-scoped
success events).

##### Option D — Promise-based save handle, no new events

Instead of events, expose a per-save promise. `Repo.#saveFn` captures and
routes it (e.g. to a per-doc registry of pending save promises that
`#waitForStored` reads from).

**Pros:** Closer to the actual control flow — the save is already a Promise
inside `StorageSubsystem.saveDoc`.

**Cons:** Doesn't compose well with `asyncThrottle`'s batch-collapsing. Many
awaiter-saves are folded into one I/O; correlating "which awaiter's heads
did _this_ I/O cover" still needs a heads-based check — exactly what the
event approach does. Bypasses the established event-driven pattern of the
subsystem.

#### Decision: Option A

Confirmed. Reasons:

1. Fixes the durability premise (events post-I/O) at the same time as
   adding the error surface — both bugs in one stroke.
2. Symmetric naming (`doc-saved` / `doc-failed-save`, `doc-compacted` /
   shared `doc-failed-save`) keeps the event surface predictable.
3. Composes cleanly with the existing throttled-batch model: `#waitForStored`
   listens for either event filtered by `documentId`; on `doc-saved` checks
   heads-include, on `doc-failed-save` rejects.
4. Same shape lets us fix `Repo.#saveFn`'s `void`-swallow as a natural
   side-effect — telemetry gains a previously-missing failure surface for
   free.

Option D (per-save Promise surface) was the closest alternative —
appealing because the save is already a Promise inside `saveDoc` — but
`asyncThrottle`'s batch-collapsing makes it a non-starter: many
awaiter-saves fold into one I/O, so correlating "which awaiter's heads
did _this_ I/O cover" still needs heads-include checking, which is
exactly what the event-based approach gives us with less ceremony.
Promisifying the events is the real solution.

#### Sub-questions to settle during implementation

1. **Compaction error: shared event or distinct?** `doc-failed-save` with a
   `type: "incremental" | "snapshot"` discriminator, vs. separate
   `doc-failed-compact`. Lean: single event with discriminator, mirroring
   how compaction is internally a save variant.
2. **Rejection scope: only the failing save's heads, or all in-flight
   awaiters?** Throttle batching means many awaiters watch for heads
   coverage at once. Strict reading: only the awaiter whose target heads
   are covered by the failing save's `targetHeads` rejects. Practical
   reading: storage is broken — reject all current awaiters for that doc
   (the next save will probably fail too). Lean: practical. Worth a
   sanity check against real adapter semantics — some adapters might
   reject transiently (network blip) where a retry would succeed.
3. **Retry behavior:** Adding `doc-failed-save` does **not** imply any
   retry policy. Application-layer recovery (queues, WAL) stays out of
   scope per Design Decision #9.
4. **`doc-metrics` re-emission:** Should `doc-metrics` re-emit
   `doc-failed-save` too so telemetry has a single subscription point?
   Lean yes — the current "saves in metrics, failures nowhere" asymmetry
   is part of the bug.
5. **Bookkeeping ordering on failure:** On save failure, `chunkInfos` and
   `headsHandle.update` should _not_ be advanced — the chunk wasn't
   actually written. Implementation must put bookkeeping inside the
   try-success path. (Current `#saveIncremental` updates bookkeeping
   after `storageAdapter.save()`; moving the event emit alongside it is
   the right shape.)
6. **`saveSyncState` and `removeDoc`:** Same pattern? `saveSyncState`
   currently propagates errors silently (caller is `Repo` again).
   `removeDoc` similarly. Worth a consistency pass once the save-path
   pattern is set, but not in scope for unblocking `#waitForStored`.

### Design decisions

Settled. Recorded here so the rationale doesn't get lost.

1. **Separate async methods (sibling, not signature change).** Existing
   sync methods (`change`, `changeAt`, `merge`, `create`) stay exactly as
   they are. Awaitable variants land as new sibling methods
   (`changeAsync`, `changeAtAsync`, `mergeAsync`, `createAsync`). Reasons:
   (a) zero diff for existing callers — no new unhandled-rejection surface,
   no need for a `void` opt-out convention; (b) TS types cleanly
   discriminate intent at the call site — `change()` returns `void`,
   `changeAsync()` returns `Promise<UrlHeads>`, no ambiguity; (c) the
   two-method API surface is small and predictable, mirroring the
   widely-understood `fs.readFile` / `fs.readFileSync` style. An earlier
   draft considered promisifying `change()` itself (single method with
   `void handle.change(...)` opt-out) — rejected on the back-compat /
   surprise-rejection grounds above.
2. **Async methods throw if `!isReady()`.** All new async methods that
   operate on an existing handle's doc — `changeAsync`, `changeAtAsync`,
   `mergeAsync`, `whenSaved` — throw synchronously when called on a
   handle whose state is not `ready` (loading, requesting, unavailable,
   unloaded, deleted). This mirrors today's sync `change()`, which
   already throws on `!isReady()`. Same `Error` shape; same call site
   guard. (`createAsync` is exempt — by definition it's creating the
   handle.) Rationale: a caller who tries to write to a non-ready
   handle is making a programming error; a clear thrown error surfaces
   the bug at the call site rather than letting the Promise resolve or
   hang in an unexpected way.
3. **Throttle batching is desirable, not a bug.** `#saveFn` is
   `asyncThrottle`d. Multiple rapid `changeAsync()` calls share a batched
   flush. Every awaiter resolves when the batch's flush produces a
   `doc-saved` whose heads cover the awaiter's target. This works because
   heads-include is monotonic — a later batched save covers all earlier
   targets. Rapid writes coalesce, and each awaiter sees its change
   durably persisted as soon as _any_ save covering it lands.
4. **No storage configured → resolve immediately.** On a storage-less repo,
   `changeAsync()` resolves with the new heads immediately after the
   in-memory `A.change`. This matches the "best-effort" semantics for that
   configuration: there is no durability guarantee to wait on.
5. **`changeAtAsync()` returns `Promise<UrlHeads | undefined>`.** Mirrors
   today's sync `changeAt()` which returns `UrlHeads | undefined`,
   preserving the existing `undefined` semantics for cases where the
   change can't apply at the requested scope.
6. **`mergeAsync()` returns `Promise<UrlHeads>`.** Same heads-returning
   treatment. `update()` is `@hidden` / internal — its async sibling can
   land alongside `mergeAsync` if a clear need appears; otherwise skip
   for Phase 1.
7. **Storage errors reject the async Promise; events emit after I/O
   (Option A).** Storage durability is the entire point of awaiting;
   swallowing storage errors defeats it. `StorageSubsystem`'s save path
   is restructured (see
   [Storage error event design](#storage-error-event-design)) so
   `doc-saved` / `doc-compacted` fire _after_ the actual I/O succeeds and
   a new `doc-failed-save` fires on rejection. `#waitForStored` resolves
   on the success event (with heads-include check) and rejects on the
   failure event. The sync `change()` path is unchanged from the
   caller's perspective: storage errors continue to surface via
   `doc-metrics` as today (additionally — the section also fixes
   `Repo.#saveFn`'s current `void`-swallow so failures actually reach
   `doc-metrics`).
8. **`@remarks` documents async latency.** Saves are throttled, so an
   awaited `changeAsync()` may take noticeably longer to resolve than the
   synchronous `A.change` step. Document this clearly so callers
   understand the tradeoff when choosing `changeAsync()` over `change()`.
9. **Application-layer crash recovery is out of scope.** Stronger
   durability guarantees than "storage adapter accepted the write" —
   disk-backed queues, WAL-style replay, health-check-gated request
   handlers — belong in the application. Automerge-repo's job is to expose
   the durability primitives (`whenSaved()`, `changeAsync()` /
   `createAsync()` Promises, storage-error rejection) so applications can
   build their own recovery strategies on top. A repo with a local
   persistent adapter (e.g. IndexedDB on a browser client) gets
   crash-recovery automatically once `changeAsync()` resolves; the gap is
   only on repos that are the canonical store for data they receive over
   the wire (i.e. sync servers — see "Out of scope: server-side
   receive→durability gap").
10. **`Repo.find()` stays event-based for now.** A Promise-returning
    `findAsync()` that resolves "once the doc is here" sounds clean, but
    the ref may be an orphan that never arrives — the Promise would hang
    forever, with no signal to distinguish "still loading" from "will never
    come." Solving this needs a richer model (per-peer "I don't have it"
    replies, settling on "asked all peers", explicit orphan signals,
    timeouts, progress events…) and is deferred. Today's event-based
    `find()` API stays. See
    [Future considerations: Promise-returning `Repo.find()`](#promise-returning-repofind-and-orphan-refs).

### Task list

- **Restructure `StorageSubsystem.#saveIncremental` and `#saveTotal`** to
  wrap `storageAdapter.save(...)` in try/catch. Emit `doc-saved` /
  `doc-compacted` _after_ successful I/O (not before). Emit new
  `doc-failed-save` event on rejection. Move chunkInfos / headsHandle
  bookkeeping inside the try-success path so it doesn't advance on
  failure. (Per [Storage error event design](#storage-error-event-design)
  Option A.)
- **Fix `Repo.#saveFn`'s `void`-swallow** ([Repo.ts:191-209](packages/automerge-repo/src/Repo.ts#L191-L209))
  so storage rejections are caught and re-emitted as `doc-metrics`
  (currently dropped entirely).
- Re-emit storage events on `DocHandle` (`storage-saved`, `storage-failed`).
- Implement `#waitForStored(heads, signal)` on `DocHandle`. Resolves on
  storage-saved covering heads, rejects on storage-failed or signal abort.
- Add `DocHandle.changeAsync()` sibling to existing `change()`, returning
  `Promise<UrlHeads>` under the storage-only contract above. Sync `change()`
  unchanged.
- Add `DocHandle.changeAtAsync()` sibling to existing `changeAt()`,
  returning `Promise<UrlHeads | undefined>` (preserves the `undefined`
  semantics).
- Add `DocHandle.mergeAsync()` sibling to existing `merge()`, returning
  `Promise<UrlHeads>`.
- Add `DocHandle.whenSaved(options?: { signal? })` returning `Promise<void>`.
- Add `Repo.createAsync()` sibling to sync `create()`, resolving once
  storage has the initial heads.
- `@privateRemarks` on each new async method: which events drive
  resolution, why `signal` cancels only the await.
- `@remarks` on each: throttled save latency is real and awaited; the
  promise does **not** wait for network broadcast; existing sync sibling
  remains available for fire-and-forget.
- **`StorageSubsystem` unit tests** for the save-path restructure:
  - `doc-saved` fires _after_ `storageAdapter.save()` resolves, not before
    (use a deferred-resolution mock adapter; assert event ordering).
  - `doc-compacted` likewise post-I/O on the compaction path.
  - `doc-failed-save` fires when `storageAdapter.save()` rejects, with the
    expected payload shape (`documentId`, `targetHeads`, `error`).
  - On save failure, `chunkInfos` and last-saved-heads do **not** advance
    (assert state is unchanged after a rejected save).
  - `Repo.#saveFn` re-emits a failed save through `doc-metrics` (the
    `void`-swallow fix).
- **`DocHandle` async-method tests:** for `changeAsync` / `changeAtAsync` /
  `mergeAsync` / `whenSaved` / `createAsync`:
  - Throws synchronously if `!isReady()` (loading, unavailable, deleted)
    — per Decision #2.
  - Happy path: resolved heads match `A.getHeads(doc)`.
  - Storage-less repo: resolves immediately with the new heads.
  - Storage error: Promise rejects.
  - `signal` abort: rejects with `signal.reason`; the change is still in
    memory (`signal` only cancels the await).
  - No-op change (empty callback): resolves with unchanged heads.
  - `whenSaved()` on a freshly-loaded handle (no in-memory edits since
    load): resolves immediately via the already-saved fast path.
  - `whenSaved()` after `repo.create()`: resolves once initial save lands.
  - `createAsync()` happy path + storage error.
  - Batched throttle window: multiple rapid `changeAsync()` calls all
    resolve from a single flush, each with its own target heads.
  - Patches derivable from returned heads via `A.diff(doc, before, after)`.

---

# Phase 2 — apply the same pattern elsewhere

Candidates (not in scope for this branch):

- `Repo.delete()` → resolves when storage's `removeDoc` and peer notifications
  are done.
- `Repo.flush()` → already async; semantics already correct.
- `DocHandle.broadcast(message)` → resolves when emitted to all peer adapters.
  Probably not worth it — ephemeral messages are fire-and-forget by design.

---

# Future considerations (not scoped)

## Awaiting network broadcast (deferred, doubtful at best)

Phase 1 deliberately does not let callers await network broadcast. This
section captures what such a feature would look like, why it was considered,
and the reasons we're skeptical it earns its complexity.

**What the feature would be.** An opt-in option on `changeAsync()` (e.g.
`awaitFor: "network" | "both"`, dropped from Phase 1) that resolves once a
sync message covering the change's heads has been emitted to every peer
connected to the relevant `DocSynchronizer` at the moment the change
landed. Plus a `whenSynced()` per-handle equivalent of `whenReady()`.

**What it would require.**

- Two new `DocSynchronizer` events: `doc-synced ({ peerId, sentHeads })`
  fired after `#sendSyncMessage` emits a sync message; `peer-removed
({ peerId })` lifting today's implicit `endSync` into an event so the
  awaiting Promise can stop waiting on departed peers.
- Re-emission of those on `DocHandle` as `peer-synced` / `peer-removed`.
- A `#waitForBroadcast(heads, peers, signal)` primitive that tracks one
  Promise per peer in a snapshot of `currentSyncedPeers()`. Each per-peer
  Promise resolves on `peer-synced` covering `heads`, or on `peer-removed`
  (we don't block forever on departed peers).
- Snapshot semantics: which peers count? The set at the moment the change
  landed, or the set at the moment `changeAsync()` was called? Behavior on
  newly-joined-mid-flight peers must be specified.

**Why we're skeptical it's worth doing.**

1. **"We sent it" ≠ "they have it."** A broadcast-emission resolution tells
   the caller a sync message was handed to the network adapter. It does
   not say the peer received it, decoded it, applied it, or stored it. The
   guarantee is much weaker than its name suggests.
2. **Storage already covers the real fear.** What a caller usually wants is
   "I won't lose this change." Storage durability gives them that; network
   broadcast is incremental performance, not durability. Sync to peers
   happens on its own schedule anyway, with retries on reconnect.
3. **Disconnect/snapshot semantics are subtle.** Treating `peer-removed`
   as resolution makes the contract weaker (a peer that disconnects right
   after the change won't get it on this call, only via future sync). But
   _not_ treating it as resolution risks the Promise hanging forever.
   Either choice is defensible; neither is satisfying.
4. **Promise contract drift.** The more we add to the resolution criteria,
   the harder it is to explain. "Resolves when storage saves" is one
   sentence; "resolves when storage saves AND every peer that was
   connected at the moment the change landed either received the message
   or departed" is harder to keep straight in tests, in JSDoc, and in
   caller code.

**Possible reasons to revisit.** A concrete use case where a caller
genuinely needs "peers have been informed" as a synchronous-after-await
guarantee — e.g. a coordinator that needs to know peers were addressed
before tearing down a connection. If such a use case appears, build it
then. Until then, the existing event-based observability (per-peer
listeners on `DocSynchronizer`) is sufficient for telemetry and debugging
without committing to a Promise contract.

---

## Promise-returning `Repo.find()` and orphan refs

Today's `Repo.find(url)` returns a `DocHandle` immediately and fires events
as the doc loads from storage / arrives from peers. The natural
promisification — resolve once the doc is here — has a real correctness
problem: the ref may be an **orphan** that never arrives. No peer has it,
storage doesn't have it, and the URL is structurally valid but
unsatisfiable. A naive Promise hangs forever with no signal distinguishing
"still loading" from "will never come."

A robust async `find()` needs more than just `Promise<DocHandle<T>>`:

- A way to know when the system has _finished trying_ (e.g. all
  currently-connected peers have replied "I don't have it" → settle as
  not-found). Sync protocol does not currently carry an explicit
  "don't-have-it" reply.
- A way to bound the wait (caller-supplied timeout / signal; not a default,
  since legitimate slow peers exist).
- A way to distinguish "not yet" from "never" in the resolution, so callers
  can decide whether to wait longer or give up.

Whether the right primitive is `findAsync(url, { signal, timeout? }):
Promise<DocHandle<T>>` plus a richer protocol underneath, or progress
events on the existing event-based API, is open. **Deferred** — not
attempting in Phase 1.

The current event-based `find()` API stays unchanged.

---

## Out of scope for this plan

- Per-peer delivery confirmation (acks). Sync state already does this at the
  Automerge protocol level, but lifting it into the `changeAsync()` promise
  would conflate "sent" with "received", and would deadlock on slow peers.
- Restructuring xstate state machine. The `UPDATE` payload + synchronous
  `A.change` call stays — only the post-update event chain is wrapped.
- **Server-side receive→durability gap.** When a peer sends a sync message,
  the receiving repo applies it to the in-memory doc and updates sync state
  synchronously, then kicks off the throttled save. If the receiver crashes
  between the in-memory apply and storage commit, the sender believes the
  receiver has the change (sync state advanced on both sides) but the
  receiver loses it on restart. This gap is real but matters only for repos
  that are the **canonical store** for data they receive over the wire —
  i.e. sync servers without their own upstream of truth. Per Design
  Decision #9 (application-layer crash recovery out of scope), the right
  fix lives at the application layer: a sync server that needs stronger
  durability than "storage adapter accepted the write" should layer a
  disk-backed queue or WAL in front of its writes, not push the
  responsibility into automerge-repo's synchronizer. Pushing it in would
  be invasive (sync state currently advances synchronously inside the
  message handler) for a problem the application can solve better with
  its own context. Repos with their own local persistent storage (e.g. an
  IndexedDB-backed browser client) are unaffected: a client crash loses
  nothing not already in IndexedDB, and a future reconnection
  re-synchronizes from there.

## Risk summary (remaining work)

| Item                                     | Risk                                                                                | Mitigation                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| API surface growth                       | Doubling change/changeAt/merge/create with `*Async` siblings adds methods to learn  | Symmetric naming (`Async` suffix everywhere) + clear `@remarks`    |
| `whenSaved()` / `createAsync()` ordering | Verify create's synchronous `handle.update()` reliably enqueues a save before await | Unit test create→whenSaved / createAsync on a slow storage adapter |
| Storage error event surface              | Unclear whether a single subscribable error event exists today                      | Audit `StorageSubsystem` events first; add one if needed           |
