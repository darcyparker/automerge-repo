import { isAbortErrorLike } from "./withAbort.js"
import { isTimeoutErrorLike } from "./withTimeout.js"

/**
 * Detects if `candidate` is a cancellation-shaped error — either an
 * AbortError (from `controller.abort()`) or a TimeoutError (from
 * `AbortSignal.timeout()`).
 *
 * @remarks
 * Use this when your catch site wants to treat "user aborted" and "timed out"
 * the same. Use {@link isAbortErrorLike} or {@link isTimeoutErrorLike} when
 * you specifically need to distinguish them. See
 * [`dev-docs/abort-patterns.md`](../../dev-docs/abort-patterns.md) for the
 * distinction.
 *
 * @see {@link isAbortErrorLike}
 * @see {@link isTimeoutErrorLike}
 */
export const isCancellationLike = (candidate: unknown): boolean =>
  isAbortErrorLike(candidate) || isTimeoutErrorLike(candidate)
