# Abort patterns and best practices

Guidance for using `AbortSignal` in the `automerge-repo` API surface. The rules
here are codebase-wide; the helpers that implement them live in
[`src/helpers/withAbort.ts`](../src/helpers/withAbort.ts).

## When to accept an `AbortSignal`

**Yes:** methods that do real work the caller might want to skip: storage I/O,
long network sends. Accept it via the `AbortOptions` interface so the option
shape is uniform across the codebase:

```ts
import { AbortOptions } from "./helpers/withAbort.js"

load(key: StorageKey, options?: AbortOptions): Promise<...>
```

**No:** lifecycle "wait-for-state" methods whose returned promise is shared
across callers (e.g. `whenReady()`, a future `whenSaved()`, etc.). See the
sharing rule below.

**Also no:** synchronous event-dispatch entry points (e.g.
`Synchronizer.receiveMessage`). A network message has already arrived; dropping
it mid-processing creates a sync hole.

## Honoring the signal in an async method

Once you've accepted an `AbortSignal`, the idiomatic way to check it inside an
`async` method is `signal.throwIfAborted()`:

```ts
async load(
  key: StorageKey,
  options?: AbortOptions
): Promise<Uint8Array | undefined> {
  options?.signal?.throwIfAborted()   // ← idiomatic abort check
  // ... do the I/O ...
}
```

Why `throwIfAborted()` rather than a manual check:

- It's the [standard `AbortSignal` method](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/throwIfAborted), giving instant recognition for readers.
- It propagates `signal.reason` automatically. If the caller did
  `abortController.abort(customReason)`, that exact reason reaches the rejection.
  Hand-rolled `if (signal.aborted) throw new AbortError()` discards the
  caller's reason, a real and silent bug.
- Inside an `async` function, a synchronous throw becomes a promise rejection.
  So `throwIfAborted()` works exactly like you want without any try/catch
  ceremony.
- The optional-chain (`options?.signal?.throwIfAborted()`) makes the whole
  thing a one-line no-op when the caller didn't pass a signal.

### Where to put the check

- **At the entry** of the async work, before any expensive setup. Cheap, and
  short-circuits the already-aborted case.
- **At every iterator yield**, in both sync and async iterators. The iterator's
  consumer chooses when to call `next()` and can defer arbitrarily. Between
  yields, the producer may be sitting there with the signal already aborted
  but no chance to observe it. Check before producing each value:

  ```ts
  async function* readChunks(reader, signal?: AbortSignal) {
    while (true) {
      signal?.throwIfAborted()
      const { value, done } = await reader.read()
      if (done) return
      yield value
    }
  }
  ```

- **Not needed** right after an operation that already participates in abort.
  `await fetch(url, { signal })` already throws on abort; following it with
  `signal?.throwIfAborted()` is redundant: the await would have thrown first.
  Same goes for any async dependency you forwarded `signal` into.

The rule of thumb: check whenever the function is **about to do work that
won't itself observe the abort signal**. Setup, a sync loop, a `setTimeout`
you manage yourself, a library call that doesn't accept an `AbortSignal`:
those are the moments to gate with `throwIfAborted()`.

### When NOT to use `throwIfAborted()`

Inside a **non-`async` function that returns a `Promise<T>` directly** (for
example {@link withAbort} itself), a `throwIfAborted()` would throw
synchronously to the caller rather than producing a rejected promise. That
changes the contract. In that shape, use:

```ts
if (signal.aborted) return Promise.reject(signal.reason)
```

This still propagates `signal.reason`, but as a rejected promise rather than a
synchronous throw.

### What `throwIfAborted()` throws

- `abortController.abort()` (no args) → throws the platform-default
  `DOMException` with `name === "AbortError"`.
- `abortController.abort(customReason)` → throws `customReason` unchanged.

Detect either at the catch site with {@link isAbortErrorLike} (when you only
care that it was _some_ AbortError-shape), or by identity comparison against
your own reason value.

## Composing signals

`AbortSignal` provides three static factory methods. Use them to construct
signals that pair with one another (and with caller-provided signals) instead
of wiring abort listeners by hand:

- **`AbortSignal.any([...signals])`** composes signals. The returned signal
  aborts when the first input aborts; its `reason` matches that input's.
- **`AbortSignal.timeout(ms)`** is a signal that aborts after `ms` ms. Its
  `reason` is a `DOMException` with `name === "TimeoutError"` (not
  `"AbortError"`; catch handlers that distinguish should check `err.name`).
- **`AbortSignal.abort(reason?)`** is a signal that's already aborted.
  Convenient in tests and as a sentinel.

All three are available in Node 20+ and modern browsers (2024).

### Typical composition

When your async work needs to abort for more than one reason (caller
cancelled OR a local timeout fired OR your own lifecycle event), combine the
sources with `any()`:

```ts
async function fetchWithTimeout(url: string, signal?: AbortSignal) {
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(5000)])
    : AbortSignal.timeout(5000)
  return await fetch(url, { signal: combined })
}
```

The composed `signal.reason` is whichever source aborted first.

### Don't wire it by hand

Pre-`AbortSignal.any()` code often did:

```ts
parentSignal.addEventListener("abort", () =>
  ownController.abort(parentSignal.reason)
)
```

That works but leaks the listener if `ownController` settles first.
`AbortSignal.any()` handles cleanup for you and is what readers expect to see
in modern code.

## The sharing rule

> **A promise that is memoized, cached, or otherwise handed to more than one
> caller MUST NOT be abortable from the inside.**

One caller's abort would reject the shared promise, and any co-waiter holding
it would see that rejection, even though they never asked to abort.

Concrete example: `adapter.whenReady()` returns the same `Promise<void>` to
every caller. If we let it accept a signal and one caller aborted, the
_adapter's_ internal ready promise would reject, breaking everyone else.

## Race externally, not internally

To bail out of awaiting a shared promise without poisoning others, race the
wait **at the call site** instead of plumbing `signal` into the shared promise:

```ts
// Sugar, preferred for single waits:
await withAbort(adapter.whenReady(), signal)

// Equivalent and preferred for multiple sequential waits sharing one signal:
const [abortPromise, dispose] = abortToPromise(signal)
await Promise.race([adapter.whenReady(), abortPromise])
await Promise.race([handle.whenReady(), abortPromise])
dispose() // detach the abort listener once the waits are done
```

The underlying `adapter.whenReady()` keeps running regardless. Only your local
wait gets interrupted.

### Wrapping a non-abort-aware API

The same technique covers libraries that return a `Promise` but accept no
`AbortSignal`: race the call against your signal so the caller can stop
waiting.

```ts
// crypto.subtle.digest returns a Promise but takes no signal:
const hash = await withAbort(crypto.subtle.digest("SHA-256", data), signal)
```

The underlying work still runs to completion (you cannot truly cancel it from
outside). What `withAbort` buys you is the ability to stop awaiting it.

## `withAbort` vs. raw `Promise.race`: which to use

Both produce the same observable behavior. `withAbort` is sugar over
`Promise.race` against an abort-driven promise. The choice is about ergonomics
and listener efficiency.

### When `withAbort(promise, signal)` is better

- **One wait point.** No abort-promise variable to manage.
- **Optional signal.** `withAbort(p, undefined)` is a no-op (returns
  `Promise.resolve(p)`). No `if (signal)` branch at the call site.
- **Listener cleanup is automatic** and tied to the wrapped promise settling.
- **`signal.reason` is propagated for free** on both the already-aborted fast
  path and the race path.

```ts
await withAbort(adapter.whenReady(), signal)
```

### When `Promise.race([p, abortPromise])` is better

- **Multiple sequential awaits in one function**, all bailing on the same
  signal. Build the abort-promise once with `abortToPromise(signal)`; race
  against it N times. One listener registration instead of N.
- **You already have an `abortPromise: Promise<never>` parameter** passed in by
  a parent. The function is just applying it.
- **The function signature exposes "bail-out" as a value**, not a signal,
  useful for plumbing cancellation through a multi-step async flow.

```ts
async function awaitWithBailout(abortPromise: Promise<never>) {
  // build the abort-promise once; race it N times (one listener, not N)
  await Promise.race([networkSubsystem.whenReady(), abortPromise])
  await Promise.race([handle.whenReady(), abortPromise])
}
```

### Rule of thumb

| Situation                                       | Use                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| 1 wait point in scope                           | `withAbort(p, signal)`                                                 |
| N wait points all sharing the same bail-out     | Build `abortToPromise(signal)` once; race each wait against it         |
| Function takes a pre-built bail-out from caller | `Promise.race` (signature exposes `abortPromise: Promise<never>`)      |
| Optional signal where you don't want a branch   | `withAbort` (the `undefined` case is built in)                         |

In this codebase the **forwarding** variant is what's actually used:
[`Repo.find`](../src/Repo.ts) calls `signal?.throwIfAborted()` for the
already-aborted fast path, then forwards `signal` into
`DocumentQuery.whenReady({ signal })`
([`DocumentQuery.ts`](../src/DocumentQuery.ts)), which honors it directly. Reach
for `withAbort` or the shared-`abortPromise` pattern above only when you must
race a promise that can't take the signal itself, e.g. a shared `whenReady()`
you must not poison (see [The sharing rule](#the-sharing-rule)).

### Building a reusable abort-arm

For several sequential waits that all bail on one signal, build a single arm with
[`abortToPromise`](../src/helpers/abortToPromise.ts). It returns a
`[promise, dispose]` tuple: destructure the promise under whatever name reads
best. It registers one `{ once: true }` abort listener; the promise rejects with
`signal.reason` on abort and otherwise never settles.

The reference graph is one-way (`signal → listener → promise`), so **holding the
promise does not retain the `signal`**, but **holding the `signal` retains the
arm**. `dispose()` removes the listener; it deliberately does _not_ settle the
promise (force-settling a `Promise<never>` would corrupt any race still using
it), so after `dispose()` the promise is left pending and collected once you drop
it.

> **Pitfall: a long-lived signal that never aborts.** Because the promise never
> settles, every `Promise.race([work, arm])` leaves a reaction on it that clears
> only when it settles (on abort) or is collected. With an operation-scoped signal
> (one find, one request) that is automatic: the whole arm is collected when the
> operation ends. Pair it with a page- or app-lifetime signal that never aborts
> and those reactions accumulate for the life of the signal. Prefer an
> operation-scoped signal; if you must use a long-lived one, call `dispose()` when
> you are done racing.

> **Do not build the arm as `withAbort(foreverPromise, signal)`** (nor as any
> `Promise.race([foreverPromise, …])`). `Promise.race` calls `.then` on every arm,
> so racing the never-settling
> [`foreverPromise`](../src/helpers/foreverPromise.ts) singleton appends a reaction
> to it that is **never released** (it never settles), pinning the race promise,
> the suspended frame, and the captured `signal` + listener for the whole session.
> `DocHandle.whenReady` returns `foreverPromise` when there is nothing to await, so
> that is the one place it appears — reach for `abortToPromise(signal)` everywhere
> else.

## Continuation after abort

`withAbort`, `withTimeout`, and racing against an `abortToPromise(signal)` arm all
**reject** on abort/timeout (with `signal.reason` or a `TimeoutError`). The
`await` therefore _throws_: execution does not fall through to the statements
after it, so a bail needs no post-await flag check. Let the rejection propagate,
or catch it:

```ts
const handle = await withAbort(this.networkSubsystem.whenReady(), signal) // throws if aborted
handle.request()
this.#registerHandleWithSubsystems(handle)
```

If you want to re-assert the bail explicitly (for instance to turn a _tie_, where
the wrapped work resolved in the same microtask the signal aborted, into a clean
throw), call `signal.throwIfAborted()` after the await.

A post-await `if (signal.aborted) return` flag check is only needed when the abort
side-channel **resolves** rather than rejects (e.g.
`Promise.race([work, new Promise(res => signal.addEventListener("abort", res))])`).
None of the helpers here resolve on abort, so they don't need it.

## When to use `withTimeout`

[`withTimeout(p, ms)`](../src/helpers/withTimeout.ts) races `p` against a
wall-clock deadline. If `p` settles first, its value is returned and the
internal timer is cleared. If the deadline elapses first, the returned promise
rejects with a `TimeoutError` whose message includes the elapsed ms.

Reach for it when you need a deadline on a promise and don't already have a
richer `AbortSignal` story:

```ts
// Give an operation a 5s deadline; retry on timeout:
try {
  return await withTimeout(doSlowLoad(), 5_000)
} catch (err) {
  if (isTimeoutErrorLike(err)) return retry()
  throw err
}
```

`withTimeout` takes no `AbortSignal`. If you need both a deadline and a
caller-cancelable signal, compose them with `AbortSignal.any` and use
`withAbort` (see below).

## `withTimeout(p, ms)` vs. `withAbort(p, AbortSignal.timeout(ms))`

Both reject with a `TimeoutError`-shaped error at the deadline (detectable via
`isTimeoutErrorLike`), so either works. For the simple "race one promise
against a deadline" case, prefer `withTimeout(p, ms)`:

- **`withTimeout` cancels its own timer.** Once `p` settles, `clearTimeout`
  runs in `finally`, so no background timer persists. `AbortSignal.timeout(ms)`
  exposes no cancel hook, so its timer keeps running until `ms` elapses even
  after `p` resolved. Harmless, but wasted work and a surprise when tracing
  what is pending.
- **`withTimeout`'s rejection message carries the elapsed `ms`.**
  `AbortSignal.timeout`'s reason is a generic `DOMException` without that
  context.

Reach for `withAbort(p, AbortSignal.timeout(ms))` only when you genuinely need
to compose the timeout with other abort sources:

```ts
const combined = AbortSignal.any([userSignal, AbortSignal.timeout(5_000)])
await withAbort(p, combined)
```

## `AbortError` and `signal.reason`

When you abort, the rejection carries `signal.reason`:

- `abortController.abort()` (no args) → `signal.reason` is a platform
  `DOMException` with `name === "AbortError"`.
- `abortController.abort(customError)` → `signal.reason === customError`. The custom
  reason flows through `withAbort` unchanged.

To detect an aborted-shape error from any source, use
[`isAbortErrorLike`](../src/helpers/withAbort.ts):

```ts
try { ... }
catch (err) {
  if (isAbortErrorLike(err)) { /* aborted */ }
  else { throw err }
}
```

### `TimeoutError` is not `AbortError`

If your signal was composed with `AbortSignal.timeout(ms)` and the timeout
fires, the rejection reason is a `DOMException` with `name === "TimeoutError"`,
not `"AbortError"`. `isAbortErrorLike` returns `false` for those; it only
matches the AbortError shape.

Three predicates are exported, one per intent (each co-located with the error class it matches):

| Predicate                                                    | Matches                   | Use when                                                                                                                        |
| ------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`isAbortErrorLike`](../src/helpers/withAbort.ts)            | `name === "AbortError"`   | You specifically care that abort was triggered explicitly (not a timeout).                                                      |
| [`isTimeoutErrorLike`](../src/helpers/withTimeout.ts)        | `name === "TimeoutError"` | You specifically care that a timeout fired (e.g. retry on timeout, propagate on user cancel).                                   |
| [`isCancellationLike`](../src/helpers/isCancellationLike.ts) | either of the above       | You want to treat "user aborted" and "timed out" the same, typically when categorizing failures for logs or skipping recovery. |

`isCancellationLike` is just `isAbortErrorLike(e) || isTimeoutErrorLike(e)`.

```ts
try { ... }
catch (err) {
  if (isAbortErrorLike(err))   { /* user/caller aborted */ }
  else if (isTimeoutErrorLike(err)) { /* timed out, maybe retry */ }
  else { throw err }
}
```

The platform keeps the two names distinct on purpose so callers that _do_
need different recovery paths can discriminate.

## References

- MDN: [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
- MDN: [`AbortSignal.any()`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/any_static)
- MDN: [`AbortSignal.timeout()`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static)
- MDN: [`AbortSignal.abort()`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/abort_static)
- MDN: [`AbortController`](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
- MDN: [`DOMException.name`](https://developer.mozilla.org/en-US/docs/Web/API/DOMException/name), recognized names, including `"AbortError"`.
- WebIDL spec: [`DOMException`](https://webidl.spec.whatwg.org/#idl-DOMException)
- DOM spec: [`AbortController`](https://dom.spec.whatwg.org/#interface-abortcontroller)
