# Contributing

## Development workflow

Prerequisites:

- pnpm

To install dependencies and build the packages run:

```sh
pnpm install
pnpm build
```

Note: You need to build the packages before running the demo apps.

### Running the demo apps

```sh
pnpm dev
```

### Running tests

Currently tests require Node 20 and don't run on Node 22.

```sh
pnpm test
```

## Patterns and conventions

- **Abort-signal support:** when accepting `AbortSignal` in an API, see
  [`packages/automerge-repo/dev-docs/abort-patterns.md`](packages/automerge-repo/dev-docs/abort-patterns.md)
  for the rules (in particular: do not plumb `AbortSignal` into shared/memoized
  promises; race externally).
