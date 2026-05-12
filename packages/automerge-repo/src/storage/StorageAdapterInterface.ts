import { AbortOptions } from "../helpers/withAbort.js"
import { StorageKey, Chunk } from "./types.js"

export type StorageAdapterLoadOptions = AbortOptions

/** A storage adapter represents some way of storing binary data for a {@link Repo}
 *
 * @remarks
 * `StorageAdapter`s provide a key/value storage interface. The keys are arrays of strings
 * ({@link StorageKey}) and the values are binary blobs.
 */
export interface StorageAdapterInterface {
  /**
   * Load the single value corresponding to `key`.
   *
   * @remarks
   * Pass `options.signal` to bail out of a long load; safe to omit otherwise.
   *
   * @privateRemarks
   * Real I/O — `signal` is cooperative. Implementations may ignore it. See
   * [`dev-docs/abort-patterns.md`](../../dev-docs/abort-patterns.md) for the
   * rule that this signal must not be plumbed into any shared/memoized promise.
   */
  load(
    key: StorageKey,
    options?: StorageAdapterLoadOptions
  ): Promise<Uint8Array | undefined>

  /** Save the value `data` to the key `key` */
  save(key: StorageKey, data: Uint8Array): Promise<void>

  /** Remove the value corresponding to `key` */
  remove(key: StorageKey): Promise<void>

  /**
   * Load all values with keys that start with `keyPrefix`.
   *
   * @remarks
   * The `keyprefix` will match any key that starts with the given array. For example:
   * - `[documentId, "incremental"]` will match all incremental saves
   * - `[documentId]` will match all data for a given document.
   *
   * Be careful! `[documentId]` would also match something like `[documentId, "syncState"]`! We
   * aren't using this yet but keep it in mind.)
   *
   * Pass `options.signal` to bail out of a long load.
   *
   * @privateRemarks
   * Real I/O — `signal` is cooperative. Implementations may ignore it. See
   * [`dev-docs/abort-patterns.md`](../../dev-docs/abort-patterns.md).
   */
  loadRange(
    keyPrefix: StorageKey,
    options?: StorageAdapterLoadOptions
  ): Promise<Chunk[]>

  /** Remove all values with keys that start with `keyPrefix` */
  removeRange(keyPrefix: StorageKey): Promise<void>
}
