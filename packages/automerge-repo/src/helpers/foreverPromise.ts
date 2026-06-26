/* c8 ignore start */
/**
 * A promise that never settles.
 *
 * @remarks
 * Do NOT race this (e.g. `Promise.race([foreverPromise, x])` or
 * `withAbort(foreverPromise, signal)`): racing a never-settling singleton appends
 * a reaction to it that is never released, so the race and everything it captures
 * are retained for the whole session. For a cancelable wait use {@link withAbort}
 * or {@link abortToPromise}; for a deadline use {@link withTimeout}.
 *
 * Only used by the deprecated `DocHandle.whenReady` when there is nothing to
 * await; it will be removed alongside it.
 */
export const foreverPromise = new Promise<never>(() => {})
/* c8 ignore end */
