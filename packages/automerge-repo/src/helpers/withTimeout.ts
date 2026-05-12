/* c8 ignore start */
/**
 * If `promise` is resolved before `t` ms elapse, the timeout is cleared and the result of the
 * promise is returned. If the timeout ends first, a `TimeoutError` is thrown.
 */
export const withTimeout = async <T>(
  promise: Promise<T>,
  t: number
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new TimeoutError(`withTimeout: timed out after ${t}ms`)),
      t
    )
  })
  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * An `Error` subclass with `name === "TimeoutError"`, matching the platform
 * convention used by `AbortSignal.timeout()`'s rejection reason.
 *
 * @remarks
 * Detect with {@link isTimeoutErrorLike}. The `name`-based check also catches
 * `DOMException` instances with `name === "TimeoutError"` (what
 * `AbortSignal.timeout()` produces), so a single catch site handles both
 * sources.
 */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TimeoutError"

    // V8: trim the stack trace so it starts at the throw site, not inside this constructor.
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, this.constructor)
    }
  }
}

/**
 * Detects if `candidate` is a `TimeoutError`-shaped error — either an instance
 * of our {@link TimeoutError} class, or any `DOMException`/`Error` whose
 * `name === "TimeoutError"` (e.g. what `AbortSignal.timeout()` produces as
 * `signal.reason` when its timer fires).
 *
 * @remarks
 * Use this when your catch site specifically wants to recognize "the operation
 * timed out" — e.g. retry on timeout but propagate on user-aborted.
 *
 * @see {@link isCancellationLike} for the union of abort and timeout shapes.
 */
export const isTimeoutErrorLike = (candidate: unknown): boolean => {
  return (
    candidate instanceof TimeoutError ||
    ((candidate instanceof Error ||
      // In some JS environments, DOMException is not defined, and sometimes when defined, it does not extend Error; hence extra checks
      (DOMException && candidate instanceof DOMException)) &&
      candidate.name === "TimeoutError")
  )
}
/* c8 ignore end */
