import { pause } from "../../src/helpers/pause.js"
import {
  Message,
  NetworkAdapter,
  PeerId,
  PeerMetadata,
} from "../../src/index.js"
import { NetworkAdapterReadyOptions } from "../network/NetworkAdapterInterface.js"
import { AbortError } from "./abortable.js"

type HasAbortHandler = { abortHandler: (this: AbortSignal) => void }

export class DummyNetworkAdapter extends NetworkAdapter {
  #sendMessage?: SendMessageFn

  #connected = false
  #ready = false

  #readyPromiseWithResolversAndAbortHandler = new Map<
    AbortSignal | undefined,
    PromiseWithResolvers<void> & Partial<HasAbortHandler>
  >()

  isReady() {
    return this.#ready
  }

  whenReady(options?: NetworkAdapterReadyOptions): Promise<void> {
    if (this.#ready) {
      return Promise.resolve()
    }
    const { signal: signalOrUndefined } = options ?? {}
    //Get and reuse existing ready `{ promise, resolve, reject, abortHandler }`, or create new ones
    let { promise, resolve, reject, abortHandler } =
      this.#readyPromiseWithResolversAndAbortHandler.get(signalOrUndefined) ??
      (Promise.withResolvers<void>() as PromiseWithResolvers<void> &
        Partial<HasAbortHandler>)

    if (signalOrUndefined && !abortHandler) {
      abortHandler = function (this: AbortSignal) {
        //Note: when abortHandler is called, `this` is the abort signal. Reject with the abort signal's reason
        reject?.(this.reason)
      }
      signalOrUndefined.addEventListener("abort", abortHandler, { once: true })
    }
    this.#readyPromiseWithResolversAndAbortHandler.set(signalOrUndefined, {
      promise,
      resolve,
      reject,
      abortHandler,
    })

    return promise
  }

  #forceReady() {
    if (!this.#ready) {
      this.#ready = true
      //Resolve the 0 or more ready promises (which are reused by signalOrUndefined)
      for (const [
        signalOrUndefined,
        { resolve, abortHandler },
      ] of this.#readyPromiseWithResolversAndAbortHandler.entries()) {
        resolve()
        if (abortHandler && signalOrUndefined)
          signalOrUndefined.removeEventListener("abort", abortHandler)
      }
      this.#readyPromiseWithResolversAndAbortHandler.clear()
    }
  }

  // A public wrapper for use in tests!
  forceReady() {
    this.#forceReady()
  }

  constructor(opts: Options = { startReady: true }) {
    super()
    if (opts.startReady) {
      this.#forceReady()
    }
    this.#sendMessage = opts.sendMessage
  }

  async connect(
    peerId: PeerId,
    options?: PeerMetadata & NetworkAdapterReadyOptions
  ) {
    this.peerId = peerId
    await this.whenReady(options)
    this.#connected = true
  }

  disconnect() {
    this.#ready = this.#connected = false

    //Reject the 0 or more ready promises (which are reused by signalOrUndefined)
    for (const [
      signalOrUndefined,
      { reject, abortHandler },
    ] of this.#readyPromiseWithResolversAndAbortHandler.entries()) {
      reject(new AbortError("disconnected before ready"))
      if (abortHandler && signalOrUndefined)
        signalOrUndefined.removeEventListener("abort", abortHandler)
    }
    this.#readyPromiseWithResolversAndAbortHandler.clear()
  }

  peerCandidate(peerId: PeerId) {
    this.emit("peer-candidate", { peerId, peerMetadata: {} })
  }

  override send(message: Message) {
    if (!this.#connected) {
      return
    }
    this.#sendMessage?.(message)
  }

  receive(message: Message) {
    if (!this.#connected) {
      return
    }
    this.emit("message", message)
  }

  static createConnectedPair({ latency = 10 }: { latency?: number } = {}) {
    const adapter1: DummyNetworkAdapter = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) =>
        pause(latency).then(() => adapter2.receive(message)),
    })
    const adapter2: DummyNetworkAdapter = new DummyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) =>
        pause(latency).then(() => adapter1.receive(message)),
    })

    return [adapter1, adapter2]
  }
}

type SendMessageFn = (message: Message) => void

type Options = {
  startReady?: boolean
  sendMessage?: SendMessageFn
}
