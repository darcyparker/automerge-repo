# Promisification Plan — Phase 1

Branch: `darcy/promisifications_phase1_on_handleCacheRefactor_on_PR618`
Stack:

- `main`
  - PR #618 (`document-query`)
    - `darcy/raceTest_on_PR618`
      - `darcy/weakCaches_on_PR618` (handleCacheRefactor phase 0 — WeakValueMap)
        - `darcy/handleCacheRefactor-based-weakCaches_on_PR618` (handleCacheRefactor phase 1 plan)
          - **`darcy/promisifications_phase1_on_handleCacheRefactor_on_PR618`** ← this branch

Status: design only — no Phase 1 implementation yet.

## What this branch is for

Give `DocHandle.change()` and friends awaitable async siblings
(`changeAsync`, `whenSaved`, `createAsync`) that resolve once the change
has been durably written to storage. A `change()` that doesn't guarantee
persistence is an incomplete primitive — a crash between the in-memory
`A.change` and the throttled storage save loses the change with no
signal to the caller. Phase 1 closes that gap.

Phase 0 (abort-signal hygiene — `withAbort`, signal.reason propagation,
storage `AbortOptions`, "not abortable" docs) lives on a separate
branch: **`darcy/promisifications_phase0_on_PR618`**, off
`darcy/raceTest_on_PR618`. It's independent — these two could land in
either order, but `darcy/raceTest_on_PR618 → phase 0 → phase 1` is a
natural sequence because phase 1 uses `withAbort` and the
abort-signal patterns from phase 0.

## Prerequisite: handleCacheRefactor (landed)

The handleCacheRefactor work this section originally depended on has shipped on this branch's ancestors. Concretely:

- `Repo.#queriesByHandle: WeakMap<DocHandle, DocumentQuery>` + `Repo.#queryHandleByDocumentId: WeakValueMap<DocumentId, DocHandle>` — storage now follows consumer lifetime.
- `Repo.#handleCleanupRegistry: FinalizationRegistry<DocumentId>` — when a handle is GC'd, iterates `#sources` calling `source.detach(documentId)`, then `#syncStateTracker.delete(documentId)`. Held value is the documentId (primitive — safe).
- `DocSynchronizer.#query: WeakRef<DocumentQuery>` — the synchronizer no longer pins the handle through the query.
- `DocHandle.#viewCache` / `#refCache` are `WeakValueMap`s.
- README "Memory lifetime — consumer responsibilities" section documents the consumer-facing contract.

A subsequent memory audit drove a follow-up fix in `RefImpl`: the originally-planned `FinalizationRegistry` for Ref cleanup turned out to have a held-value-captures-target bug — the registry retained its held value strongly while the target was alive, and the held value's closure captured `this`, so the registry's callback could never fire. The chosen fix was to **delete the registry entirely** and rely on the natural `Ref ↔ DocHandle` cycle for the typical case (drop both → collected together) plus an explicit public `dispose()` for the narrow "drop the Ref, keep the handle alive" case. That outcome directly informs Phase 1: there are two viable shapes for `#waitForStored`, and the simpler one (no registry, listen on the handle's own EventEmitter) avoids the same trap. See "Listener strategy: open question" below.

The mental model still stands: _if the consumer no longer holds a strong ref to a `DocHandle`, automerge-repo's memory for that doc gets GC'd._ Phase 1's `#waitForStored` primitive — the backbone of `changeAsync`, `whenSaved`, `createAsync` — must respect that mental model and not silently pin the handle through a closure.

### The leak shape Phase 1 must avoid

The natural-looking but wrong implementation:

```ts
#waitForStored(heads, signal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSaved = (ev) => {
      // closes over `this` (the handle) AND the target heads
      if (
        ev.documentId === this.documentId &&
        headsInclude(ev.savedHeads, heads)
      ) {
        cleanup()
        resolve()
      }
    }
    this.#repo.storageSubsystem.on("doc-saved", onSaved)
    // ...
  })
}
```

That `onSaved` closure pins the handle through `this`. If a caller does

```ts
const handle = await repo.find(url)
void handle.whenSaved() // start the await, don't bother with the promise
handle = null // drop our reference
// (the returned promise is also unreachable now)
```

…the handle should become GC-eligible under handleCacheRefactor's mental model. But the listener on `storageSubsystem` (a long-lived `Repo`-owned object) is still registered, and the listener closure pins the handle. The handle leaks. **This is exactly the leak handleCacheRefactor exists to solve, recreated by a careless `#waitForStored` implementation.**

Two design shapes avoid the leak — see "Listener strategy: open question" below.

### Listener strategy (decided: Option B)

`#waitForStored` subscribes to `storage-saved` / `storage-failed` on `DocHandle.events` (re-emitted by the bridge in task #3), not on `StorageSubsystem` directly. The listener lives inside the handle's own `EventEmitter`. When the consumer drops the handle:

- `handle.events` dies with the handle, taking the listener with it.
- The Promise's resolution path is no longer reachable from anywhere; the Promise becomes inert garbage.

No `FinalizationRegistry` needed. Same shape as the Ref-cleanup outcome: the natural cycle handles it.

#### Tradeoffs accepted

- **Hard dependency on the storage-events bridge.** Task #3 (re-emit `storage-saved` / `storage-failed` on `DocHandle`) is now load-bearing, not nice-to-have. Without it, `#waitForStored` has nothing to listen to on the handle side. The bridge itself is small — `Repo` already listens on `storageSubsystem.on("doc-saved", ...)` to re-emit via `doc-metrics`, so a per-handle re-emission is a similar shape.

- **Promise stranding when handle is dropped mid-wait.** A consumer who calls `await handle.whenSaved()` then drops the handle without aborting via `signal` will be stuck awaiting forever. The listener dies with the handle (good — no leak), but the Promise itself is still alive and pending. Callers should: (a) drop the Promise reference too, (b) abort via `signal`, or (c) hold both handle and Promise until the await settles. Document this on `whenSaved` / `changeAsync` JSDoc.

- **No defensive backup mechanism for listener cleanup.** Option A (rejected — see below) offered a `FinalizationRegistry` as a safety net that would clean up if the natural cycle failed. Option B has only the natural cycle. If a future change accidentally pins the listener from outside the handle (e.g. some new module stashes the listener function elsewhere), the leak comes back without a backup catching it. Mitigation: the dedicated leak test in the task list verifies the listener is unattached after handle GC.

- **Closure-capture discipline inside the executor still matters.** The listener implementation calls `this.off("storage-saved", ...)` in its cleanup — capturing `this` transitively. That's fine because the resulting `handle → events → listener → this → events` chain is a self-referential cycle internal to the handle (analogous to the `Ref ↔ DocHandle` cycle). Collected as a unit when nothing external pins. But contributors editing `#waitForStored` should understand this distinction — "internal-to-handle capture = OK, external capture (e.g. on `Repo`-owned object) = pin." Worth a comment in the implementation.

- **Per-save listener fan-out.** Every `doc-saved` from `StorageSubsystem` triggers a re-emission on every alive handle that has the bridge listener attached. For applications with many handles this is a small constant factor — each handle has one shared bridge listener regardless of how many `#waitForStored` calls are pending against it. Negligible at typical scale; worth noting only because Option A would have avoided it (one subsystem listener per pending wait, fired only when relevant).

#### Alternative considered (rejected): Option A — listen on `StorageSubsystem` directly, with a new `FinalizationRegistry`

Subscribe to `doc-saved` / `doc-failed-save` on the (Repo-owned) `StorageSubsystem`, and use a new `FinalizationRegistry` to remove the listener if the handle is GC'd mid-wait. Rejected because the held value passed to the registry must not capture `this`, even transitively — same held-value-captures-target trap the Ref refactor uncovered. Avoiding the trap requires a WeakRef-inside-listener discipline that's invasive and exactly the complexity the Ref refactor chose not to take on. Option B's natural-cycle approach is structurally consistent with the Ref outcome and avoids the trap entirely.

#### Sketch

```ts
#waitForStored(heads, signal): Promise<void> {
  const documentId = this.documentId  // primitive, safe to capture

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (settled) return
      settled = true
      this.off("storage-saved", onSaved)
      this.off("storage-failed", onFailed)
      signal?.removeEventListener("abort", onAbort)
    }

    const onSaved = (ev: { savedHeads: UrlHeads }) => {
      if (headsInclude(ev.savedHeads, heads)) {
        cleanup()
        resolve()
      }
    }
    const onFailed = (ev: { error: Error; targetHeads: UrlHeads }) => {
      if (headsInclude(ev.targetHeads, heads)) {
        cleanup()
        reject(ev.error)
      }
    }
    const onAbort = () => {
      cleanup()
      reject(signal!.reason)
    }

    this.on("storage-saved", onSaved)
    this.on("storage-failed", onFailed)
    signal?.addEventListener("abort", onAbort)

    // Already-saved fast path. Subscribe first, then check —
    // a save that lands between the check and the subscribe
    // wouldn't be missed.
    if (coverageCheck(this.#repo.storageSubsystem, documentId, heads)) {
      cleanup()
      resolve()
    }
  })
}
```

Subscribe-before-check is intentional: the fast-path check runs _after_ the listener registration so a save that lands between the check and the subscribe isn't lost.

Note that this sketch's listener body uses `this` implicitly (via `this.off(...)`). That's fine — `this` is the handle, the listener lives inside the handle's EventEmitter, the captured-this cycle is internal and collected as a unit when the consumer drops both.

## Guiding principles

Unchanged from the broader promisification plan:

- **Storage is the durability boundary; network is best-effort.** A
  `Repo` has at most one storage adapter; persistence to local storage
  is the strong "the change won't be lost" signal. Broadcasting to peers
  is eventual.
- **Separate async methods, not signature changes.** Sync `change()` /
  `create()` stay exactly as they are. New methods (`changeAsync`,
  `whenSaved`, `createAsync`) are siblings — no back-compat surface, no
  unhandled-rejection trap for non-awaiting callers, TS types
  discriminate intent at the call site.
- **Promisify only when a natural completion event exists.** The events
  for "storage durably has these heads" exist (modulo timing fix —
  see below) on `StorageSubsystem`. The events for "every peer has
  this change" do not, which is why network-await is deferred.

## Motivation

Today's `change()` is fire-and-forget. `StorageSource` kicks off a
throttled save via `asyncThrottle` after a `heads-changed` event fires;
the caller's `change()` returns immediately. There is no way for the
caller to know whether the change reached the storage adapter — a
crash between the in-memory mutation and the throttled save loses the
change with no signal anywhere.

A secondary motivation: the events for "durably saved" already exist
but reach callers as a stream of EventEmitter messages across two
subsystems. Collapsing that into a single `await` is a real ergonomic
win.

The chain we care about (post-#618, post-handleCacheRefactor):

```
user calls handle.change(cb)   // or handle.changeAsync(cb)
  └─ DocHandle.#doc = A.change(doc, ..., cb)
       └─ DocHandle emits "heads-changed" (and "change")
            └─ StorageSource's per-handle asyncThrottle save
                  └─ StorageSubsystem.saveDoc(...)
                       └─ StorageSubsystem emits "doc-saved" / "doc-compacted"
```

`changeAsync()` waits for the final `doc-saved` step before resolving;
`change()` returns immediately after the in-memory `A.change`.

## Design

### Contract

`changeAsync()` returns `Promise<UrlHeads>` — the document's heads after
the change has landed in memory and storage has confirmed a save
covering them.

- The promise resolves with the target heads once `StorageSubsystem`
  emits a `doc-saved` (or `doc-compacted`) whose `savedHeads` covers
  those heads, **after** the actual `storageAdapter.save()` I/O
  completes. (See "Storage error event design" — today these events
  fire before the I/O completes, which Phase 1 changes.)
- No-op changes (callback didn't mutate) resolve immediately with the
  unchanged heads.
- No storage adapter → resolves immediately after the in-memory step;
  no durability to wait on.
- Storage error during the awaited save → Promise rejects with the
  error.
- `options.signal` aborts → rejects with `signal.reason`. The change
  is already in memory; the signal cancels only the await.

The sync `change()` is unchanged: fire-and-forget, throttled save in
the background, storage errors continue to surface via `doc-metrics`
as today. `changeAsync()` is a new method, not a replacement.

**Why return heads?** Given any two head states, callers can compute
the patches between them via `A.diff(doc, before, after)` — that
makes `(before, after)` the canonical checkpoint for undo/redo and
change logs without committing this layer to a patch shape. Heads are
small (an array of hashes); patches can be large. Returning heads is
lossless on information and cheap on bytes.

### Sibling API surface

```ts
// DocHandle (existing — unchanged)
change(callback: A.ChangeFn<T>, options?: A.ChangeOptions<T>): void
changeAt(heads: UrlHeads, callback: A.ChangeFn<T>, options?: A.ChangeOptions<T>): UrlHeads | undefined
merge(otherHandle: DocHandle<T>): void

// DocHandle (new — Phase 1)
changeAsync(callback: A.ChangeFn<T>, options?: A.ChangeOptions<T> & { signal?: AbortSignal }): Promise<UrlHeads>
changeAtAsync(heads: UrlHeads, callback: A.ChangeFn<T>, options?: A.ChangeOptions<T> & { signal?: AbortSignal }): Promise<UrlHeads | undefined>
mergeAsync(otherHandle: DocHandle<T>, options?: { signal?: AbortSignal }): Promise<UrlHeads>
whenSaved(options?: { signal?: AbortSignal }): Promise<void>

// Repo (existing — unchanged)
create<T>(initialValue?: T): DocHandle<T>

// Repo (new — Phase 1)
createAsync<T>(initialValue?: T, options?: { signal?: AbortSignal }): Promise<DocHandle<T>>
```

### `whenSaved()` — companion durability primitive

Not every "wait for storage" caller issued the change themselves. A
request handler that does `repo.create(data)` (which internally creates
a handle pre-populated with initial heads, and `StorageSource.attach`
immediately fires its throttled `saveFn` because the heads are
non-empty) needs to confirm storage has the change before responding.
The sync `create()` returns a handle, not a promise.

```ts
whenSaved(options: { signal?: AbortSignal } = {}): Promise<void> {
  if (this.isDeleted()) throw new Error(...)
  return this.#waitForStored(
    encodeHeads(A.getHeads(this.#doc)),
    options.signal,
  )
}
```

The `isDeleted()` guard is the post-#618 equivalent of the legacy
`!isReady()` check — handles are always ready when handed out; the
only remaining error-terminal state is `deleted`.

### `createAsync()`

Effectively `create + await whenSaved`:

```ts
async createAsync<T>(
  initialValue?: T,
  options?: { signal?: AbortSignal },
): Promise<DocHandle<T>> {
  const handle = this.create<T>(initialValue)
  await handle.whenSaved(options)
  return handle
}
```

If the repo has no storage adapter, resolves with the handle
immediately. Storage errors and aborts reject; same semantics as
`whenSaved`.

### `#waitForStored(heads, signal)`

The shared primitive. Sketch given in the [Prerequisite section](#prerequisite-handlecacherefactor) under "Listener strategy: open question" — pending the choice between Option A (listen on `StorageSubsystem` with a Phase-1-specific `FinalizationRegistry`) and Option B (listen on `DocHandle.events` via the bridge, natural cycle handles cleanup).

Behavior (independent of A vs. B):

- Already-saved fast path: before subscribing, check storage's last-saved-heads for this doc. If those cover `heads`, resolve immediately. (No event will fire if no save needs to happen.)
- Otherwise listen for `doc-saved` / `doc-compacted` events whose `savedHeads` covers `heads`, filtered by `documentId`.
- Resolves on the first matching event.
- Rejects on `doc-failed-save` covering this doc (Phase 1 introduces this event — see "Storage error event design" below).
- Rejects if `signal` aborts (with `signal.reason`).
- No storage subsystem → resolves immediately.
- Handle GC'd mid-wait → under Option A, cleanup fires via `FinalizationRegistry`; under Option B, the listener dies with `handle.events`. The returned Promise is unreachable at that point in either case, so its non-resolution is a non-issue.

### Storage error event design

`#waitForStored` needs two things from `StorageSubsystem` that don't
exist in the right shape today:

1. `doc-saved` / `doc-compacted` need to fire **after** the
   `storageAdapter.save()` I/O completes. Today they fire after the
   in-memory `A.saveSince` / `A.save` encoding step but before the
   actual write returns — so listening for `doc-saved` today resolves
   on "Automerge encoded the binary," not on "storage adapter accepted
   it." That premise has to be true for durability awaits to mean
   anything.
2. A failure event. Today storage errors propagate out of
   `StorageSubsystem.saveDoc` but the throttled call in
   `StorageSource` swallows them (no try/catch around the
   `asyncThrottle` flush). No event, no metric, nothing.

**Option A (chosen)**: restructure `#saveIncremental` and `#saveTotal`
in `StorageSubsystem` to wrap the I/O in try/catch and emit a new
`doc-failed-save` on rejection. Move the existing `doc-saved` /
`doc-compacted` emission to the success branch _after_ the I/O. Move
the chunkInfos / headsHandle bookkeeping inside the same success
branch so it doesn't advance on failure. Same fix lets us catch the
throttled save's rejection in `StorageSource` and re-emit through
`doc-metrics` so telemetry sees the failure.

Rejected alternatives:

- **Option B** (keep `doc-saved` pre-I/O, just add `doc-failed-save`):
  leaves `doc-saved`'s durability premise wrong; would need a second
  "save settled" event for `#waitForStored` to listen to.
- **Option C** (single `doc-save-result` discriminated event): less
  ergonomic — subscribers who only care about success have to branch.
  Cuts against the existing narrowly-scoped style.
- **Option D** (per-save promise registry, no events): `asyncThrottle`
  batches saves, so correlating "which awaiter's heads did this I/O
  cover" still needs heads-include checking — the same shape as the
  event approach with more ceremony.

Bridged through `Repo` → `DocHandle`:

- `DocHandle.on("storage-saved", { savedHeads })` — re-emit per handle.
- `DocHandle.on("storage-failed", { error, targetHeads })` — same.

No new sync/peer events in Phase 1.

## Design decisions (settled)

1. **Sibling methods, not signature changes** — sync versions stay
   untouched; `*Async` variants are new methods. Zero diff for existing
   callers; no unhandled-rejection trap; TS types discriminate intent.
2. **Throw on terminal-error state.** Post-#618, this collapses to
   `isDeleted()` — handles are always ready on receipt. View-only
   handles (`#fixedHeads`) also throw, matching sync `change()`'s
   `#throwIfFixedHeads`. `createAsync` is exempt (it's creating the
   handle).
3. **Throttle batching is desirable.** `StorageSource`'s `saveFn` is
   `asyncThrottle`d; multiple rapid `changeAsync()` calls share a
   batched flush. Each awaiter resolves when the batch's save covers
   its target heads. Heads-include is monotonic, so a later save
   covers earlier targets — rapid writes coalesce, no awaiter is
   stranded.
4. **No storage configured → resolve immediately.** No durability to
   wait on, so the promise has nothing to wait for.
5. **Heads return values match sync variants.** `changeAsync` →
   `UrlHeads`; `changeAtAsync` → `UrlHeads | undefined` (preserves
   the `undefined` semantics for cases where the change can't apply
   at the requested scope); `mergeAsync` → `UrlHeads`.
6. **Storage errors reject the async promise.** The whole point of
   awaiting is durability; swallowing storage errors defeats it.
   Sync `change()`'s path is unchanged from the caller's perspective.
7. **`@remarks` documents async latency.** `asyncThrottle` means an
   awaited `changeAsync()` may take noticeably longer to resolve than
   the synchronous `A.change` step — call this out clearly so callers
   understand the tradeoff vs. `change()`.
8. **Application-layer crash recovery is out of scope.** Stronger
   durability guarantees than "storage adapter accepted the write" —
   disk-backed queues, WAL-style replay, health-check-gated request
   handlers — belong in the application. automerge-repo exposes
   primitives (`whenSaved`, `changeAsync`, storage-error rejection);
   applications build their own strategies on top. Sync servers that
   need stronger durability for received-over-wire data should
   layer their own infrastructure rather than push it into the
   synchronizer.
9. **Listener strategy = Option B (listen on `DocHandle.events`).**
   `#waitForStored` subscribes to bridged `storage-saved` /
   `storage-failed` events on the handle's own `EventEmitter`, not on
   `StorageSubsystem` directly. The natural cycle handles cleanup —
   no `FinalizationRegistry` needed. Same outcome shape as the Ref
   refactor, which deleted its registry for the same reason. See the
   [Listener strategy section](#listener-strategy-decided-option-b)
   for tradeoffs accepted and why Option A was rejected.

## Task list

1. **Restructure `StorageSubsystem.#saveIncremental` and `#saveTotal`**
   to wrap `storageAdapter.save(...)` in try/catch. Emit `doc-saved` /
   `doc-compacted` after successful I/O. Emit `doc-failed-save` on
   rejection. Move chunkInfos / headsHandle bookkeeping into the
   try-success path.
2. **Fix `StorageSource`'s lost rejection** — catch the `asyncThrottle`
   flush's rejection and re-emit through whatever Repo-level
   `doc-metrics` forwarder is appropriate post-#618.
3. **Bridge storage events on `DocHandle`** as `storage-saved` /
   `storage-failed`.
4. **Implement `#waitForStored(heads, signal)` on `DocHandle`** —
   per the [Listener strategy section](#listener-strategy-decided-option-b)
   (Option B: subscribe to bridged events on `DocHandle.events`; the
   sketch in that section is the target shape). Requires task #3 as a
   hard prerequisite.
5. **`changeAsync`, `changeAtAsync`, `mergeAsync`** — sibling methods,
   storage-only contract above. Sync variants unchanged.
6. **`whenSaved`** — standalone durability await.
7. **`createAsync`** — `create + whenSaved`.
8. **JSDoc** on each: `@privateRemarks` for the event-driving
   mechanics; `@remarks` for the throttle latency note and the
   "signal cancels the await, not the change" semantics.
9. **Tests**:
   - `StorageSubsystem` save-path: `doc-saved` fires after I/O (use a
     deferred-resolution mock adapter), `doc-failed-save` fires on
     rejection with expected payload, bookkeeping doesn't advance on
     failure.
   - `DocHandle` async-method tests: synchronous throw on deleted /
     view-only; happy path heads match `A.getHeads(doc)`; storage-less
     repo resolves immediately; storage error rejects; signal abort
     rejects with `signal.reason`; no-op change resolves with
     unchanged heads.
   - `whenSaved` already-saved fast path; `whenSaved` after
     `repo.create()` resolves once initial save lands.
   - `createAsync` happy path + storage error.
   - **Leak test** specific to the prerequisite: call
     `handle.whenSaved()` without holding the returned promise, drop
     the handle, force GC, assert the listener is no longer attached
     to `StorageSubsystem`. This is the test that prevents the
     leak this prerequisite section exists to flag.
   - Batched throttle: multiple rapid `changeAsync()` calls resolve
     from a single flush, each with its own target heads.

## Future considerations (not scoped)

### Awaiting network broadcast (deferred, doubtful at best)

Phase 1 deliberately does not let callers await network broadcast.
"We sent it" ≠ "they have it" — a broadcast-emission resolution would
tell the caller a sync message was handed to the network adapter, not
that the peer received, decoded, applied, or stored it. Weak
guarantee, easy to misread.

Storage already covers the real fear. What a caller usually wants is
"I won't lose this change"; storage durability gives them that.
Network sync happens on its own schedule with reconnect retries.

If a concrete use case appears that genuinely needs "peers have been
informed" as a synchronous-after-await guarantee (e.g. a coordinator
tearing down a connection), it can be built then. Until then,
per-peer listeners on `DocSynchronizer` give enough observability for
telemetry without committing to a Promise contract.

### Orphan refs in `Repo.find()`

PR #618 made `Repo.find` Promise-returning, partially mitigating the
old "hangs forever" concern: `DocumentQuery` transitions to
`unavailable` when every source has reported `unavailable` and none
is pending, and `whenReady()` rejects on that. The harder case —
sources that keep saying "pending" because new peers might join —
remains. Caller-supplied timeouts via `AbortSignal.timeout(ms)` are
the right primitive for that scenario; the deeper protocol question
(when have we _finished trying_) is separate from this branch.

## Out of scope

- Per-peer delivery confirmation (acks). Sync state does this at the
  Automerge protocol level; lifting it into `changeAsync`'s promise
  would conflate "sent" with "received" and deadlock on slow peers.
- **Server-side receive→durability gap.** When a peer sends a sync
  message, the receiver applies it to the in-memory doc and updates
  sync state synchronously, then kicks off the throttled save. A
  receiver-side crash between in-memory apply and storage commit
  loses the change while the sender's sync state believes it landed.
  This gap is real but matters only for repos that are the canonical
  store for data they receive over the wire (sync servers without
  their own upstream of truth). Per Decision #8, application-layer
  recovery (WAL, disk-backed queues) is the right fix — pushing it
  into automerge-repo would be invasive for a problem applications
  can solve better with their own context.

## Risk summary

| Risk                                                                                                              | Mitigation                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Listener leak when handle is dropped mid-wait                                                                     | The chosen design ([Listener strategy](#listener-strategy-decided-option-b)) attaches the listener to `DocHandle.events`, so it dies with the handle via the natural cycle. The dedicated leak test in the task list verifies this. |
| `whenSaved()` / `createAsync()` ordering — does `StorageSource.attach` actually enqueue a save before await runs? | Unit test `create → whenSaved` on a slow storage adapter.                                                                                                                                                                           |
| Storage event timing premise (events post-I/O)                                                                    | Settled — Option A in [Storage error event design](#storage-error-event-design). First task on the list.                                                                                                                            |
| API surface growth (sync + Async siblings)                                                                        | Symmetric naming, clear `@remarks` documenting the tradeoff and what signal cancels.                                                                                                                                                |

## Open questions

1. **Storage-event-timing fix scope (task #1).** The fix is to wrap I/O in try/catch in `StorageSubsystem.#saveIncremental` / `#saveTotal`, emit `doc-saved` / `doc-compacted` _after_ successful I/O, and add a new `doc-failed-save`. Any concern with that scope before implementing? In particular, the chunkInfos / headsHandle bookkeeping needs to move into the success branch — that's a behavior change for anyone reading those internal records concurrently with a failed save.
2. **Phase 0 dependency: `withAbort`.** Phase 1's `*Async` methods take `{ signal?: AbortSignal }` and propagate `signal.reason` on reject — the patterns established on `darcy/promisifications_phase0_on_PR618`. Confirm `withAbort` (and the surrounding abort-pattern conventions) is the right primitive to lean on, vs. anything that may have evolved since Phase 0 was written.
