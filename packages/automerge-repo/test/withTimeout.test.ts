import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  withTimeout,
  TimeoutError,
  isTimeoutErrorLike,
} from "../src/helpers/withTimeout.js"
import { AbortError } from "../src/helpers/withAbort.js"

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("resolves with the wrapped promise's value when it settles before the timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 100)
    expect(result).toBe(42)
  })

  it("rejects with TimeoutError when the timeout fires first", async () => {
    // A promise that never settles on its own. Capture the rejection
    // synchronously via `.catch` so the rejection has a handler before the
    // fake timer fires (otherwise vitest sees an unhandled rejection).
    const pending = new Promise<number>(() => {})
    const rejection = withTimeout(pending, 50).catch(e => e)
    await vi.advanceTimersByTimeAsync(50)
    expect(await rejection).toBeInstanceOf(TimeoutError)
  })

  it("the TimeoutError message includes the elapsed timeout in ms", async () => {
    const pending = new Promise<number>(() => {})
    const rejection = withTimeout(pending, 250).catch(e => e)
    await vi.advanceTimersByTimeAsync(250)
    expect((await rejection).message).toContain("timed out after 250ms")
  })

  it("clears the timer when the wrapped promise resolves first", async () => {
    const before = vi.getTimerCount()
    await withTimeout(Promise.resolve("ok"), 1000)
    // The 1000ms timer was cleared by the `finally`, not left dangling.
    expect(vi.getTimerCount()).toBe(before)
  })

  it("propagates a rejection from the wrapped promise (not a TimeoutError)", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 1000)
    ).rejects.toThrow("boom")
  })
})

describe("TimeoutError", () => {
  it("has name === 'TimeoutError'", () => {
    expect(new TimeoutError("x").name).toBe("TimeoutError")
  })

  it("preserves the message", () => {
    expect(new TimeoutError("hello").message).toBe("hello")
  })

  it("stack trace omits the constructor frame (V8)", () => {
    function throwIt() {
      throw new TimeoutError("trace-check")
    }
    let captured: TimeoutError | undefined
    try {
      throwIt()
    } catch (e) {
      captured = e as TimeoutError
    }
    expect(captured).toBeDefined()
    // V8 with Error.captureStackTrace omits the constructor frame; the top
    // frame is the call site, not `new TimeoutError`.
    if (typeof Error.captureStackTrace === "function") {
      expect(captured!.stack).not.toMatch(/at new TimeoutError\b/)
    }
  })
})

describe("isTimeoutErrorLike", () => {
  describe("positive cases (returns true)", () => {
    it("recognizes a TimeoutError instance (fast path)", () => {
      expect(isTimeoutErrorLike(new TimeoutError("x"))).toBe(true)
    })

    it("recognizes a DOMException whose name is 'TimeoutError'", () => {
      // What AbortSignal.timeout() produces as signal.reason on timeout.
      const dom = new DOMException("timed out", "TimeoutError")
      expect(isTimeoutErrorLike(dom)).toBe(true)
    })

    it("recognizes a generic Error whose name is 'TimeoutError'", () => {
      const err = new Error("timed out")
      err.name = "TimeoutError"
      expect(isTimeoutErrorLike(err)).toBe(true)
    })
  })

  describe("negative cases (returns false)", () => {
    it("rejects AbortError-shaped errors (not a timeout)", () => {
      expect(isTimeoutErrorLike(new AbortError())).toBe(false)
      expect(
        isTimeoutErrorLike(new DOMException("aborted", "AbortError"))
      ).toBe(false)
    })

    it("rejects a plain Error", () => {
      expect(isTimeoutErrorLike(new Error("nope"))).toBe(false)
    })

    it("rejects a DOMException with an unrelated name", () => {
      expect(isTimeoutErrorLike(new DOMException("x", "NotFoundError"))).toBe(
        false
      )
    })

    it("rejects a duck-typed object", () => {
      expect(isTimeoutErrorLike({ name: "TimeoutError", message: "x" })).toBe(
        false
      )
    })

    it("rejects null, undefined, and primitives", () => {
      expect(isTimeoutErrorLike(null)).toBe(false)
      expect(isTimeoutErrorLike(undefined)).toBe(false)
      expect(isTimeoutErrorLike("TimeoutError")).toBe(false)
      expect(isTimeoutErrorLike(42)).toBe(false)
      expect(isTimeoutErrorLike(false)).toBe(false)
    })
  })
})
