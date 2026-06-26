/**
 * Materialize an `AbortSignal` as a `Promise<never>` that rejects with
 * `signal.reason` when the signal aborts, and never settles otherwise. Returns a
 * `[promise, dispose]` tuple, so you can name the promise whatever reads best at
 * the call site.
 *
 * Use it as a reusable "abort arm" when racing several sequential waits against
 * one signal: build it once, race it N times.
 *
 * @example
 * ```typescript
 * const [aborted, dispose] = abortToPromise(signal)
 * await Promise.race([adapter.whenReady(), aborted])
 * await Promise.race([handle.whenReady(), aborted])
 * dispose() // detach the abort listener once you are done racing
 * ```
 *
 * @remarks
 * Prefer {@link withAbort} for a single wait: it removes its abort listener the
 * moment the wrapped promise settles. `abortToPromise` instead keeps its listener
 * until the signal aborts (`{ once: true }` self-removal), until `dispose()`, or
 * until the signal is garbage-collected.
 *
 * The reference graph is one-way (`signal -> listener -> promise`), so holding the
 * returned promise does NOT retain the `signal`, but holding the `signal` DOES
 * retain the arm. `dispose()` only removes the listener; it does not settle the
 * promise (force-settling a `Promise<never>` would corrupt any race still using
 * it), so afterwards the promise is left pending and collected once you drop it.
 *
 * Pitfall: under a long-lived signal that never aborts, the arm leaks. The promise
 * never settles, so every `Promise.race([work, arm])` leaves a reaction on it that
 * clears only on abort or GC; with a page-/app-lifetime signal those accumulate
 * for the life of the signal. Prefer an operation-scoped signal (one find, one
 * request), or call `dispose()` when done.
 *
 * Do not build an abort arm as `withAbort(foreverPromise, signal)` or
 * `Promise.race([foreverPromise, ...])`: racing the never-settling singleton
 * appends a reaction that is never released, pinning the race and its frame for
 * the whole session.
 *
 * @param signal - When this aborts, the returned promise rejects with
 *   `signal.reason`.
 * @returns `[promise, dispose]` - the abort promise, and an idempotent function
 *   that detaches the abort listener.
 *
 * @see [`dev-docs/abort-patterns.md`](../../dev-docs/abort-patterns.md)
 */
export function abortToPromise(
  signal: AbortSignal
): [promise: Promise<never>, dispose: () => void] {
  let rejectAbort!: (reason: unknown) => void
  const promise = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(signal.reason)
  if (signal.aborted) {
    rejectAbort(signal.reason)
  } else {
    signal.addEventListener("abort", onAbort, { once: true })
  }
  const dispose = () => signal.removeEventListener("abort", onAbort)
  return [promise, dispose]
}
