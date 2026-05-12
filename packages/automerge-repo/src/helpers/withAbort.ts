/**
 * An error thrown when an operation is aborted.
 *
 * @remarks
 * Subclass of `DOMException` with `name === "AbortError"` (set via the second
 * `DOMException` constructor argument), matching the platform convention used by
 * `fetch()`, `AbortSignal.reason` from `abortController.abort()` (called with no args), etc.
 *
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/DOMException/name | MDN: DOMException.name} — the recognized error names, including `"AbortError"`.
 * @see {@link https://webidl.spec.whatwg.org/#idl-DOMException | WebIDL spec: DOMException} — the normative definition.
 * @see {@link https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal | MDN: AbortSignal} — the `fetch()` / `AbortController` rejection pattern this matches.
 *
 * @example
 * ```typescript
 * throw new AbortError()
 * ```
 */
export class AbortError extends DOMException {
  constructor(message?: string) {
    super(message ?? "Operation aborted", "AbortError")

    // V8: trim the stack trace so it starts at the throw site, not inside this constructor.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

/**
 * Detects if candidate `Error` is an `AbortError` or AbortError-like.
 * @remarks
 * - This method detects if an error is AbortError-like (for which there could be many implementations)
 * - AbortController spec defines AbortError as DOMException or Error with `name === 'AbortError'`.
 *
 * @see {@link isCancellationLike} for the union of abort and timeout shapes.
 */
export const isAbortErrorLike = (candidate: unknown): boolean => {
  return (
    candidate instanceof AbortError ||
    ((candidate instanceof Error ||
      //In some JS environments, DOMException is not defined, and sometimes when defined, it does not extend Error; hence extra checks
      (DOMException && candidate instanceof DOMException)) &&
      candidate.name === "AbortError")
  )
}

/**
 * Wrap `promise` so the returned promise rejects with `signal.reason` if `signal`
 * aborts before `promise` settles.
 *
 * @remarks
 * Parallels {@link withTimeout}: same shape, time-based side channel replaced
 * with an abort-based one. The underlying `promise` is NOT cancelled — it keeps
 * running; only the *wait* on it is interruptible. That is exactly what makes
 * this safe to use against shared/memoized promises like `whenReady()`: each
 * caller gets their own wrapper and their own bail-out, without poisoning the
 * underlying promise for other waiters.
 *
 * Unnecessary for async APIs that natively accept a signal (e.g. `fetch`).
 *
 * @example
 * ```typescript
 * const abortController = new AbortController()
 *
 * try {
 *   const result = await withAbort(slowOp(), abortController.signal)
 *   // Concurrent code can interrupt the wait by calling abortController.abort() / .abort(reason)
 * } catch (err) {
 *   if (isAbortErrorLike(err)) console.log("aborted")
 * }
 * ```
 *
 * @param promise - A promise (or PromiseLike) to wrap.
 * @param signal - Optional AbortSignal. If omitted or undefined, the input is
 *   returned unchanged (as a `Promise<T>`).
 * @returns A promise that:
 *   - settles like `promise` if it settles before abort,
 *   - rejects with `signal.reason` if `signal` aborts first (whether before the
 *     call or during the wait — the reason is preserved consistently).
 */
export function withAbort<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (!signal) return Promise.resolve(promise)
  if (signal.aborted) return Promise.reject(signal.reason)

  let rejectAbort!: (reason: unknown) => void
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })

  return (Promise.race([promise, abortPromise]) as Promise<T>).finally(
    // `{ once: true }` auto-removes the listener when abort fires, so we only
    // need to clean up the unfired case (promise settled before abort).
    () => signal.aborted || signal.removeEventListener("abort", onAbort)
  )
}

/**
 * Include this type in an options object to pass an AbortSignal to a function.
 */
export interface AbortOptions {
  signal?: AbortSignal
}
