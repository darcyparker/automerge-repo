import { describe, it, expect } from "vitest"
import { abortToPromise } from "../src/helpers/abortToPromise.js"
import { AbortError } from "../src/helpers/withAbort.js"

describe("abortToPromise", () => {
  it("rejects with signal.reason (preserving identity) when the signal aborts", async () => {
    const controller = new AbortController()
    const reason = new AbortError("custom reason")
    const [aborted] = abortToPromise(controller.signal)
    controller.abort(reason)

    await expect(aborted).rejects.toBe(reason)
  })

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController()
    const reason = new AbortError("already aborted")
    controller.abort(reason)

    const [aborted] = abortToPromise(controller.signal)
    await expect(aborted).rejects.toBe(reason)
  })

  it("stays pending while the signal has not aborted", async () => {
    const controller = new AbortController()
    const [aborted] = abortToPromise(controller.signal)

    // A resolved promise must win the race, proving the arm has not settled.
    const winner = await Promise.race([Promise.resolve("not-aborted"), aborted])
    expect(winner).toBe("not-aborted")
  })

  it("works as one reusable arm across multiple races", async () => {
    const controller = new AbortController()
    const [aborted] = abortToPromise(controller.signal)

    expect(await Promise.race([Promise.resolve(1), aborted])).toBe(1)
    expect(await Promise.race([Promise.resolve(2), aborted])).toBe(2)

    const reason = new AbortError("done")
    controller.abort(reason)
    await expect(aborted).rejects.toBe(reason)
  })

  it("dispose() detaches the listener so a later abort does not reject the arm", async () => {
    const controller = new AbortController()
    const [aborted, dispose] = abortToPromise(controller.signal)

    dispose()
    controller.abort()

    // The arm must stay pending despite the abort: a resolved promise wins.
    const winner = await Promise.race([Promise.resolve("disposed"), aborted])
    expect(winner).toBe("disposed")
  })
})
