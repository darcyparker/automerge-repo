# Repo handle cache: weakening plan

## Goal

Make `Repo.#handleCache` track-but-not-pin, so that when a consumer drops their last reference to a `DocHandle`, the handle (and all its in-repo bookkeeping) becomes eligible for GC.

This is what the user's mental model already expects: "I dropped my handle; the repo should follow suit." Today it doesn't, because `Repo.#handleCache` and the synchronizer both hold strong references. Consumers who key their own `WeakMap`s on `DocHandle` instances are blocked from ever releasing those entries — the handle is pinned by the repo regardless of the consumer.

## Problem, restated

Consumer pattern (the real-world motivation):

```ts
const myDerivedState = new WeakMap<DocHandle<T>, Derived>()
// ... user finds a handle, attaches derived state, eventually drops the handle
```

Expected: when the user drops their handle reference, the WeakMap entry disappears. The user goes on with life.

Actual: `Repo.#handleCache` retains the handle indefinitely. The user's WeakMap entry is pinned forever. The only escape is `repo.removeFromCache()` — which, as the prior `weakRefPlan` work uncovered, doesn't even fully tear down the listeners. So consumer-side memory grows without bound for the lifetime of the `Repo`.

## Why I previously argued against weakening `#handleCache`

Three reasons, all real, none dispositive:

1. **Cross-subsystem strong refs.** `DocSynchronizer.#handle` (`DocSynchronizer.ts:65`) and `CollectionSynchronizer.docSynchronizers` (`CollectionSynchronizer.ts:19`) hold the handle. Weakening `#handleCache` alone is a no-op while those exist.
2. **Sync-message dispatch.** `Repo.ts:262, 321` route incoming network messages by `#handleCache[message.documentId]`. If the handle is gone, the message has no destination.
3. **Non-reconstitutable in-memory state.** `#syncInfoByStorageId`, the active XState actor, the save throttle, user-attached event listeners. If the handle dies and a future `find()` recreates it from storage, that state is lost.

The argument was: until you address #1, weakening the cache buys nothing.

## Reframing

We address #1 deliberately. We accept #2 as "drop the message" — a stale message for a doc the consumer no longer cares about is correctly ignorable. We accept #3 as the price of the consumer letting go: if you re-`find()` the doc later, you re-load and re-sync. That is the cost of memory correctness.

This matches the contract a memory-correct library should offer. The consumer's release of their reference is the authoritative "I don't need this" signal.

## Required changes

Four structural pieces, plus a fifth helper expansion.

### 1. `Repo.#handleCache` → `WeakValueMap<DocumentId, DocHandle<any>>`

Already have the helper. Drop-in replacement.

### 2. `DocSynchronizer.#handle` → `WeakRef<DocHandle<unknown>>`

Every access becomes `const h = this.#handle.deref(); if (!h) return /* or bail */`. There are roughly half a dozen call sites in `DocSynchronizer.ts` (search for `this.#handle.`). Each becomes a deref-and-guard.

For listener-attached methods (e.g. `#syncWithPeers`, `#broadcastToPeers`), if the deref returns undefined we silently return — the handle is gone; the work is moot.

### 3. `FinalizationRegistry<DocumentId>` keyed on the DocHandle

When the handle is collected, run a cleanup callback. The callback receives only the `DocumentId` (a string — does not pin the target, satisfies MDN's guidance):

```ts
#handleCleanupRegistry = new FinalizationRegistry<DocumentId>(documentId => {
  delete this.#progressCache[documentId]
  delete this.#saveFns[documentId]
  this.synchronizer.removeDocument(documentId)
})
```

Register on `set`-into-cache:

```ts
this.#handleCache.set(documentId, handle)
this.#handleCleanupRegistry.register(handle, documentId, handle)
```

Unregister on explicit `removeFromCache` so the callback doesn't fire later for an already-cleaned document.

This converts the listener cycle (`DocHandle ←→ DocSynchronizer`) into a chain that resolves: DocHandle dies → registry fires → DocSynchronizer is removed from `docSynchronizers` → DocSynchronizer becomes unreachable → next GC sweep collects it.

### 4. Sync-message no-op on cache miss

`Repo.ts:262, 321`:

```ts
const handle = this.#handleCache.get(message.documentId)
if (!handle) {
  this.#log("dropping message for collected handle", message.documentId)
  return
}
```

A `debug` log so we have observability for the drop, not a thrown error.

### 5. `WeakValueMap` gains alive-iteration

`Repo.handles` (a public-ish getter) and `Repo.flush()` (`Object.values(this.#handleCache)`) currently iterate the cache. Both need to switch to iterating *alive* entries from the `WeakValueMap`.

Add to `WeakValueMap`:

```ts
*aliveEntries(): IterableIterator<[K, V]> {
  for (const [key, ref] of this.#map) {
    const value = ref.deref()
    if (value !== undefined) yield [key, value]
  }
}

*aliveValues(): IterableIterator<V> {
  for (const ref of this.#map.values()) {
    const value = ref.deref()
    if (value !== undefined) yield value
  }
}
```

Deliberately omitted: `size`, `keys()`, `entries()`. Iteration is the only use case that justifies an "observable residency" exception, and we name them with `alive` prefix so the caller knows what they're getting.

`Repo.handles` will need to either change shape (return an iterator) or be reimplemented as a snapshot Record. Snapshot is safer for back-compat:

```ts
get handles(): Record<DocumentId, DocHandle<any>> {
  const snapshot: Record<DocumentId, DocHandle<any>> = {}
  for (const [id, handle] of this.#handleCache.aliveEntries()) {
    snapshot[id] = handle
  }
  return snapshot
}
```

The snapshot itself temporarily strong-refs the alive handles. That's fine — the caller is going to use them; the strong-ref ends when the caller's reference does.

## Catches and tradeoffs

These don't block the change, but they do shape the test plan and the changelog entry.

**Listener pinning is bounded.** The DocHandle's `events.change` holds closures that capture the DocSynchronizer. Those closures live *inside* the DocHandle, so they don't pin the DocHandle externally. The DocSynchronizer is held externally by `docSynchronizers`, but with `#handle` weak, it doesn't pin the DocHandle through the back-edge. The cycle resolves.

**Pending timers pin briefly.** `handle.change()` schedules an `asyncThrottle` timer (`saveDoc`, `syncWithPeers`) whose closure captures `{ handle, doc }`. Until the timer fires, Node's timer queue keeps the handle alive. This is unavoidable and not a blocker — the handle becomes collectable as soon as the timer settles. Callers who want prompt collection should `await repo.flush(id)` first. We do not need to do anything special; document the behavior.

**Re-`find()` is no longer a memoization shortcut.** Today, `find()` for a previously-cached doc is O(1). After: if the consumer dropped the previous handle, `find()` re-loads from storage and re-requests from peers. For workloads that find/drop/find the same doc, this is a real perf regression. Measure before merging on a representative workload (e.g. a UI that mounts/unmounts components keyed on docId). If the regression is meaningful, options include a short-lived strong-ref idle cache (LRU of recently-released handles, opt-in) — but that is its own design decision and is **out of scope** for this plan.

**`removeFromCache` becomes the eager teardown, not the only teardown.** Keep it. Its semantics shift from "force-clean the entry" to "force-clean now instead of waiting for GC." The existing API stays; behavior gets stronger.

**Sync-message race.** A message arrives, we look up the handle, get `undefined`, drop. Then 1ms later the consumer calls `find()` for that doc. They don't get the dropped message; the new handle re-requests. That's correct behavior, just worth being explicit about. Logged at debug level.

**Public-ish `Repo.handles` getter.** With the snapshot approach above, the API contract is preserved (returns a Record). Callers that iterated previously still iterate. Callers that mutated the returned Record (which they shouldn't have) lose that side effect; if any downstream consumer was doing this, they were on borrowed time anyway.

**`#progressCache` and `#saveFns` lifecycle.** Both are bound to `#handleCache`. With the FinalizationRegistry doing the cleanup, both get pruned automatically when the handle dies. Today they're only pruned on explicit `removeFromCache` / `delete`; this is a strict improvement.

## Tangent: this resolves part of the RefImpl pinning, indirectly

Today, RefImpl's `#updateHandler` pins the Ref while the DocHandle is alive (documented in the prior `weakRefPlan` skip rationale). After this change, when the consumer drops the DocHandle, the DocHandle becomes GC-eligible, the Ref dies with it as part of the same cycle, the existing `refCleanupRegistry` (despite its own held-value-captures-target flaw) is moot because the cleanup target is gone with everything else.

The narrower "Ref dies before its DocHandle" scenario still needs the RefImpl rework. But the dominant scenario — "consumer drops the doc entirely" — gets reclaimed as a unit. So this plan turns most of that latent leak into a non-issue without touching RefImpl.

## Test plan

In addition to the existing `weakRefPlan` GC tests:

1. **Drop-and-collect, no other activity.** `find()` a doc, capture `WeakRef`, drop the local, `flushGC()`. Expect deref undefined. Verify `repo.handles` snapshot no longer includes the id.

2. **Drop-and-collect, with pending writes.** `find()`, `change()`, drop, `await repo.flush()`, `flushGC()`. Verify reclaimed. Without the flush, expect *not* reclaimed (timer pins). Document this.

3. **Sync message for dropped handle.** Drop a handle, `flushGC()`, fire a sync message via the network adapter. Expect: no exception, `debug` log, message dropped silently.

4. **FinalizationRegistry side effects.** After a handle is collected, assert `repo.synchronizer.docSynchronizers[id] === undefined`, `(repo as any)["#progressCache"]?.[id] === undefined`, `(repo as any)["#saveFns"]?.[id] === undefined`. (Probably needs a test-only accessor or a snapshot fn.)

5. **Re-find after drop.** Drop a handle, `flushGC()`, `find()` the same id again. Expect a new handle (`!== old`), and that it re-loads from storage / re-syncs.

6. **`Repo.handles` snapshot stability.** Get a snapshot, drop the underlying handle, `flushGC()`. The snapshot still has the entry (we strong-ref'd it). The next call to `repo.handles` doesn't.

7. **Removed prematurely.** Cover the `removeFromCache` path: verify the FinalizationRegistry callback for that doc doesn't fire later (we unregistered).

GC-dependent tests use `flushGC()` from `test/helpers/flushGC.ts`, run with `--expose-gc` (already wired up in root `vitest.config.ts`).

## Implementation order

Roughly:

1. Add `aliveEntries` / `aliveValues` to `WeakValueMap` + tests.
2. Switch `DocSynchronizer.#handle` to `WeakRef` + deref guards. Run full test suite. (This change alone should be invisible in behavior; the synchronizer simply stops blocking GC. The `Repo.#handleCache` is still strong, so nothing actually gets collected yet — making this a low-risk first commit.)
3. Switch `Repo.#handleCache` to `WeakValueMap`. Update `Repo.handles` to snapshot. Update `Repo.flush()`. Update sync-message dispatch sites with cache-miss guard.
4. Add `FinalizationRegistry` for per-doc cleanup. Register on cache set, unregister on `removeFromCache`.
5. Tests above.
6. Update `weakRefPlan.md` "Findings" section to note the `removeFromCache` listener-cycle issue is now resolved (or partially resolved) by this work.

## Out of scope

- Idle LRU strong-ref cache for find/drop/find churn. Add only if benchmarks demonstrate a real regression.
- RefImpl listener-cycle rework. Still its own follow-up; this plan reduces its blast radius but does not fix the narrow "Ref outlives its DocHandle" case.
- Touching `#viewCache` (already migrated, working).
- Adding observable iteration that doesn't have the `alive` prefix.

## Decision points before starting

1. **Should `Repo.handles` keep its current Record shape (snapshot)** or switch to an iterator? Lean snapshot for back-compat unless we know callers iterate millions of entries.
2. **Cache-miss log level.** `debug` (silent in production) vs `warn` (visible). Lean `debug`; the drop is correct behavior, not an anomaly.
3. **Should `removeFromCache` be deprecated** in favor of "just drop your reference"? Lean keep — eager teardown is still useful, and removing it would be a breaking change.
4. **Test scaffolding for repo internals.** Several tests want to assert internal state (`synchronizer.docSynchronizers[id]` etc). Add a test-only `__inspect()` method on Repo, or rely on the existing public-but-`@hidden` getters. Lean on existing getters where possible.

Resolve these before writing code; they're cheap to discuss and expensive to revisit.
