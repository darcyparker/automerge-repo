import assert from "assert"
import { afterEach, describe, it, vi } from "vitest"
import { Repo, RepoConfig } from "../src/Repo.js"
import { PeerId } from "../src/index.js"
import { eventPromise } from "../src/helpers/eventPromise.js"
import { falsePromiseFactory } from "../src/helpers/falsePromiseFactory.js"
import {
  EphemeralMessage,
  isEphemeralMessage,
} from "../src/network/messages.js"
import connectRepos from "./helpers/connectRepos.js"
import { TestDoc } from "./types.js"

describe("ephemeral messages", () => {
  const repos: Repo[] = []
  const repo = (config: RepoConfig) => {
    const created = new Repo(config)
    repos.push(created)
    return created
  }
  afterEach(async () => {
    await Promise.all(repos.splice(0).map(r => r.shutdown()))
  })

  describe("relay through a sync server", () => {
    // Topology: alice <-> server <-> dan, server configured like
    // examples/sync-server (it announces nothing), so every peer on the
    // server resolves to the "share" state and the relay gates in
    // DocSynchronizer apply.
    const setup = async () => {
      const alice = repo({ peerId: "alice" as PeerId })
      const server = repo({
        peerId: "server" as PeerId,
        sharePolicy: falsePromiseFactory,
      })
      const dan = repo({ peerId: "dan" as PeerId })

      await connectRepos(alice, server)
      await connectRepos(dan, server)

      const aliceHandle = alice.create<TestDoc>({ foo: "bar" })
      const danHandle = await dan.find<TestDoc>(aliceHandle.url)

      return { alice, server, dan, aliceHandle, danHandle }
    }

    it("relays both directions in steady state", async () => {
      const { aliceHandle, danHandle } = await setup()

      const atDan = eventPromise(danHandle, "ephemeral-message")
      const atAlice = eventPromise(aliceHandle, "ephemeral-message")

      aliceHandle.broadcast({ from: "alice" })
      danHandle.broadcast({ from: "dan" })

      assert.deepStrictEqual((await atDan).message, { from: "alice" })
      assert.deepStrictEqual((await atAlice).message, { from: "dan" })
    })

    it("restores relay in both directions from ephemeral traffic alone after the server evicts the doc", async () => {
      const { server, aliceHandle, danHandle } = await setup()

      // The server drops its per-peer state for this document. The clients
      // stay connected and are unaware.
      await server.removeFromCache(aliceHandle.documentId)

      const gotAtDan: unknown[] = []
      const gotAtAlice: unknown[] = []
      danHandle.on("ephemeral-message", p => gotAtDan.push(p.message))
      aliceHandle.on("ephemeral-message", p => gotAtAlice.push(p.message))

      // A peer's standing at the relay is re-established by that peer's own
      // traffic, so each direction opens only once the receiving side has
      // also spoken, and messages sent before that are dropped (ephemeral
      // delivery is best-effort). Keep both sides broadcasting, as a
      // presence-emitting client does, until relay resumes both ways.
      await vi.waitFor(
        async () => {
          aliceHandle.broadcast({ from: "alice" })
          danHandle.broadcast({ from: "dan" })
          await Promise.resolve()
          assert.ok(gotAtDan.length > 0, "alice -> dan should recover")
          assert.ok(gotAtAlice.length > 0, "dan -> alice should recover")
        },
        { timeout: 2000, interval: 10 }
      )

      assert.deepStrictEqual(gotAtDan.at(-1), { from: "alice" })
      assert.deepStrictEqual(gotAtAlice.at(-1), { from: "dan" })
    })
  })

  describe("broadcast stamping", () => {
    // A receiver ignores any count not strictly greater than the highest it
    // has seen for that (senderId, sessionId), so all per-peer copies of one
    // broadcast carry one stamp.
    const meshSetup = async ({ bobToCharlie }: { bobToCharlie: boolean }) => {
      const alice = repo({ peerId: "alice" as PeerId })
      const bob = repo({ peerId: "bob" as PeerId })
      const charlie = repo({ peerId: "charlie" as PeerId })
      await connectRepos(alice, bob)
      await connectRepos(alice, charlie)
      if (bobToCharlie) await connectRepos(bob, charlie)

      const aliceHandle = alice.create<TestDoc>({ foo: "bar" })
      const bobHandle = await bob.find<TestDoc>(aliceHandle.url)
      const charlieHandle = await charlie.find<TestDoc>(aliceHandle.url)

      return { alice, bob, charlie, aliceHandle, bobHandle, charlieHandle }
    }

    /** Collects inbound ephemeral messages, and resolves on the first one. */
    const collectEphemeral = (target: Repo) => {
      const seen: EphemeralMessage[] = []
      const arrived = new Promise<void>(resolve => {
        target.networkSubsystem.on("message", message => {
          if (!isEphemeralMessage(message)) return
          seen.push(message)
          resolve()
        })
      })
      return { seen, arrived }
    }

    it("stamps every copy of one broadcast with the same session and count", async () => {
      const { bob, charlie, aliceHandle } = await meshSetup({
        bobToCharlie: false,
      })

      const atBob = collectEphemeral(bob)
      const atCharlie = collectEphemeral(charlie)

      aliceHandle.broadcast({ hello: "everyone" })
      await Promise.all([atBob.arrived, atCharlie.arrived])

      assert.strictEqual(atBob.seen.length, 1)
      assert.strictEqual(atCharlie.seen.length, 1)
      assert.strictEqual(atBob.seen[0].senderId, "alice")
      assert.strictEqual(atBob.seen[0].sessionId, atCharlie.seen[0].sessionId)
      assert.strictEqual(atBob.seen[0].count, atCharlie.seen[0].count)
    })

    it("keeps counts increasing across documents from one repo", async () => {
      // The counter is per repo and receivers track the high-water mark per
      // (senderId, sessionId) across every document, so two broadcasts on
      // two documents must not filter each other out.
      const alice = repo({ peerId: "alice" as PeerId })
      const bob = repo({ peerId: "bob" as PeerId })
      await connectRepos(alice, bob)

      const first = alice.create<TestDoc>({ foo: "one" })
      const second = alice.create<TestDoc>({ foo: "two" })
      const firstAtBob = await bob.find<TestDoc>(first.url)
      const secondAtBob = await bob.find<TestDoc>(second.url)

      const gotFirst = eventPromise(firstAtBob, "ephemeral-message")
      const gotSecond = eventPromise(secondAtBob, "ephemeral-message")

      first.broadcast({ doc: "one" })
      second.broadcast({ doc: "two" })

      assert.deepStrictEqual((await gotFirst).message, { doc: "one" })
      assert.deepStrictEqual((await gotSecond).message, { doc: "two" })
    })

    it("delivers a broadcast exactly once per peer in a mesh", async () => {
      // Fully-connected triangle: bob receives alice's broadcast directly
      // and again relayed by charlie. Both copies must collapse to a single
      // delivery to the application.
      const { bob, aliceHandle, bobHandle, charlieHandle } = await meshSetup({
        bobToCharlie: true,
      })

      // Bound the "exactly once" assertion on the second copy physically
      // arriving at bob's adapters, so this proves the duplicate was
      // suppressed rather than that it had not turned up yet.
      const bothCopiesArrived = new Promise<void>(resolve => {
        let arrivals = 0
        for (const adapter of bob.networkSubsystem.adapters) {
          adapter.on("message", message => {
            if (isEphemeralMessage(message) && ++arrivals === 2) resolve()
          })
        }
      })

      const gotAtBob: unknown[] = []
      const gotAtCharlie: unknown[] = []
      bobHandle.on("ephemeral-message", p => gotAtBob.push(p.message))
      charlieHandle.on("ephemeral-message", p => gotAtCharlie.push(p.message))

      aliceHandle.broadcast({ hello: "everyone" })
      await bothCopiesArrived

      assert.deepStrictEqual(gotAtBob, [{ hello: "everyone" }])
      assert.deepStrictEqual(gotAtCharlie, [{ hello: "everyone" }])
    })
  })
})
