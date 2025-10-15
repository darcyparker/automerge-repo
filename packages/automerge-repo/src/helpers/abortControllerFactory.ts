import { noop } from "./noop.js"

//abortedAbortController to reuse
const abortedAbortController = new AbortController()
abortedAbortController.abort()
export { abortedAbortController }

/**
 * Factory to create an {@link AbortController}
 * @param parentAbortSignal - optional parent abort signal. When aborted the produced AbortController will be aborted
 * @returns abortController
 * @remarks
 * If there are multiple parent abort signals, use {@link AbortSignal.any(parentSignals)} to create a parentAbortSignal
 */
export const abortControllerFactory = (
  parentAbortSignal?: AbortSignal | null
): AbortController => {
  if (parentAbortSignal?.aborted) {
    return abortedAbortController
  }

  const abortController: AbortController = new AbortController()
  const { signal } = abortController

  //When parent aborts, abort self and dispose self
  //Note: pre-emptive dispose self to save waiting for abortController.signal abort' listener in next event loop
  const parentAbortSignalHandler = (): void => {
    abortController.abort()
    disposeAbortController()
  }

  //Note: disposeAbortController() is required even though `{once: true, signal}` is used because there may
  //be cases where we want to dispose without abort() occurring
  const disposeAbortController = (): void => {
    parentAbortSignal?.removeEventListener("abort", parentAbortSignalHandler)
    signal.removeEventListener("abort", disposeAbortController)
  }

  //- When parent aborts, this abortController is aborted
  //- As well, when this abortController aborts, the parentAbortSignalHandler is removed; via `{signal}`
  //  option passed to addEventListener
  parentAbortSignal?.addEventListener("abort", parentAbortSignalHandler, {
    signal,
    once: true,
  })

  //Once aborted, disposeAbortController (note: abort is called max once, so event listener is just once)
  signal.addEventListener("abort", disposeAbortController, { once: true })

  return abortController
}
