import { EventEmitter } from "eventemitter3"
import {
  MessageContents,
  OpenDocMessage,
  RepoMessage,
} from "../network/messages.js"
import { SyncState } from "@automerge/automerge/slim"
import { PeerId, DocumentId } from "../types.js"

export abstract class Synchronizer extends EventEmitter<SynchronizerEvents> {
  /**
   * Dispatch a received wire message into the synchronizer.
   *
   * @privateRemarks
   * Intentionally not abortable: a network message is an event, and dropping
   * it mid-processing creates a sync hole. Callers also have no `AbortSignal`
   * in scope at this layer. See
   * [`dev-docs/abort-patterns.md`](../../dev-docs/abort-patterns.md).
   *
   * Return type is `Promise<void> | void` because subclasses split:
   * `DocSynchronizer.receiveMessage` is synchronous (a `switch` then dispatch);
   * `CollectionSynchronizer.receiveMessage` is `async` (it awaits `repo.find`
   * and `shareConfig.access`). `Repo.#receiveMessage` calls `.catch()` on the
   * return value to surface either path's failure.
   */
  abstract receiveMessage(message: RepoMessage): Promise<void> | void
}

export interface SynchronizerEvents {
  message: (payload: MessageContents) => void
  "sync-state": (payload: SyncStatePayload) => void
  "open-doc": (arg: OpenDocMessage) => void
  metrics: (arg: DocSyncMetrics) => void
}

/** Notify the repo that the sync state has changed  */
export interface SyncStatePayload {
  peerId: PeerId
  documentId: DocumentId
  syncState: SyncState
}

export type DocSyncMetrics =
  | {
      type: "receive-sync-message"
      documentId: DocumentId
      durationMillis: number
      numOps: number
      numChanges: number
      fromPeer: PeerId
    }
  | {
      type: "generate-sync-message"
      documentId: DocumentId
      durationMillis: number
      forPeer: PeerId
    }
  | {
      type: "doc-denied"
      documentId: DocumentId
    }
