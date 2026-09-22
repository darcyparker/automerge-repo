# Building and consuming this branch

`darcy/integration-737-743-756` merges three unmerged PRs onto `main` so they can be
installed and tested together before any of them lands:

- #737 consumer-driven document memory (GC of unobserved documents)
- #743 stop rewriting a re-engaged peer's resolved share policy
- #756 runtime floors for cbor-x and ws

Each merged cleanly against `main` and against the other two, so nothing here differs
from what the individual PRs contain.

## Build it

```bash
git clone https://github.com/darcyparker/automerge-repo.git
cd automerge-repo
git checkout darcy/integration-737-743-756

corepack enable            # the repo pins pnpm 11 via packageManager
pnpm install
pnpm build
pnpm test                  # optional: 930 passed / 4 skipped
```

Node 22.13 or newer, per `engines`.

## Pack the packages you need

```bash
mkdir -p /tmp/ar-build
for p in automerge-repo \
         automerge-repo-network-websocket \
         automerge-repo-network-broadcastchannel \
         automerge-repo-storage-indexeddb; do
  (cd packages/$p && pnpm pack --pack-destination /tmp/ar-build)
done
```

Every package here is version `2.6.0-alpha.5`, so the tarballs are named
`automerge-automerge-repo-2.6.0-alpha.5.tgz` and so on.

`pnpm pack` resolves `catalog:` to concrete ranges, so #756's raised floors
(`cbor-x ^1.6.6`, `ws ^8.21.3`, `uuid ^14.0.2`) are carried into the tarballs.

## Install into a consuming project

Use `pnpm.overrides` in the consumer's root `package.json`:

```jsonc
{
  "pnpm": {
    "overrides": {
      "@automerge/automerge-repo": "file:/tmp/ar-build/automerge-automerge-repo-2.6.0-alpha.5.tgz",
      "@automerge/automerge-repo-network-websocket": "file:/tmp/ar-build/automerge-automerge-repo-network-websocket-2.6.0-alpha.5.tgz",
      "@automerge/automerge-repo-network-broadcastchannel": "file:/tmp/ar-build/automerge-automerge-repo-network-broadcastchannel-2.6.0-alpha.5.tgz",
      "@automerge/automerge-repo-storage-indexeddb": "file:/tmp/ar-build/automerge-automerge-repo-storage-indexeddb-2.6.0-alpha.5.tgz",
    },
  },
}
```

then `pnpm install --no-frozen-lockfile`.

Two things worth knowing:

**An override is required, not optional.** `pnpm pack` resolves `workspace:*` to a
concrete version, so the adapter tarballs declare `"@automerge/automerge-repo":
"2.6.0-alpha.5"`, and that version is already published on npm. Without an override
pnpm satisfies it from the registry, and you test the published build while believing
you are testing this one. It fails silently.

**A pnpm catalog cannot hold a tarball.** `catalog:` rejects the `file:` protocol with
`ERR_PNPM_CATALOG_ENTRY_INVALID_SPEC`. Leave catalog entries alone and use overrides,
which apply to catalog-resolved dependencies as well as direct ones.

## Confirm you got this build

```bash
ls node_modules/@automerge/automerge-repo/dist/internals.js
```

That file exists only on this branch; it arrives with #737.

## Going back

Delete the `overrides` block and run `pnpm install`.
