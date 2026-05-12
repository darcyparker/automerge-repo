import { describe, it, expect } from "vitest"
import { isCancellationLike } from "../src/helpers/isCancellationLike.js"
import { AbortError } from "../src/helpers/withAbort.js"
import { TimeoutError } from "../src/helpers/withTimeout.js"

describe("isCancellationLike", () => {
  describe("positive cases (returns true)", () => {
    it("recognizes anything isAbortErrorLike recognizes", () => {
      expect(isCancellationLike(new AbortError())).toBe(true)
      expect(
        isCancellationLike(new DOMException("aborted", "AbortError"))
      ).toBe(true)
      const err = new Error("aborted")
      err.name = "AbortError"
      expect(isCancellationLike(err)).toBe(true)
    })

    it("recognizes anything isTimeoutErrorLike recognizes", () => {
      expect(isCancellationLike(new TimeoutError("timed out"))).toBe(true)
      const dom = new DOMException("timed out", "TimeoutError")
      expect(isCancellationLike(dom)).toBe(true)
      const err = new Error("timed out")
      err.name = "TimeoutError"
      expect(isCancellationLike(err)).toBe(true)
    })

    // Note: not testing AbortSignal.timeout() end-to-end. Its `reason` is
    // documented (and used elsewhere in this codebase) as a DOMException with
    // name "TimeoutError", which the DOMException test above already covers.
    // A live end-to-end test would need real-time delay — Node 19+'s
    // AbortSignal.timeout uses an internal native timer that vi.useFakeTimers
    // doesn't intercept.
  })

  describe("negative cases (returns false)", () => {
    it("rejects a plain Error", () => {
      expect(isCancellationLike(new Error("nope"))).toBe(false)
    })

    it("rejects a DOMException with an unrelated name", () => {
      expect(isCancellationLike(new DOMException("x", "NotFoundError"))).toBe(
        false
      )
    })

    it("rejects a duck-typed object", () => {
      expect(isCancellationLike({ name: "TimeoutError", message: "x" })).toBe(
        false
      )
    })

    it("rejects null, undefined, and primitives", () => {
      expect(isCancellationLike(null)).toBe(false)
      expect(isCancellationLike(undefined)).toBe(false)
      expect(isCancellationLike("TimeoutError")).toBe(false)
      expect(isCancellationLike(42)).toBe(false)
      expect(isCancellationLike(false)).toBe(false)
    })
  })
})
