# Contributing to KeeperCard

## Getting set up

```bash
bun install
git submodule update --init --recursive   # forge-std, for the contracts
cp .env.example .env                      # nothing in it is needed for the tests
```

Nothing in `.env` is required to run the tests. To make real payments the server needs
`KEEPERHUB_API_KEY` (KeeperHub executes every payment); without it each payment fails
loudly with `keeperhub_not_configured` rather than silently no-oping. Provision the
workflows once with `bun run --cwd packages/server keeperhub:provision` — the server
resolves them by name at boot, so there are no workflow ids to copy into `.env`.

## The checks

```bash
bun run test             # engine + server suites
bun run typecheck        # per-package tsc
cd contracts && forge test
bun run --cwd packages/dashboard build
```

Run `bun run test`, not a bare `bun test`. Suites that point at an unreachable RPC on
purpose need more than bun's default 5s per-test budget, because viem retries a refused
connection before the best-effort read gives up.

CI runs exactly these four.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), because releases are cut
from them by semantic-release. Keep the subject to one line.

```
feat(engine): anchor confirmed payments as on-chain receipts
fix: use the revocation-nonce test seam so the suite is order-independent
```

Types in use: `feat`, `fix`, `perf`, `refactor`, `deploy`, `docs`, `test`, `chore`.
`feat` cuts a minor release, `fix`/`perf`/`refactor`/`deploy` a patch, and
`BREAKING CHANGE:` in the body cuts a major. `docs`, `test` and `chore` release nothing.

## Tests are the argument, not the decoration

Two house rules, both learned the hard way:

- **Don't test your own assumptions against themselves.** KeeperHub's API is someone
  else's, so the KeeperHub suites replay responses captured from the real service
  (`docs/keeperhub/api-notes.md` records how it actually behaves). A mock that agrees
  with the code that wrote it proves nothing.
- **A test must not depend on the network or on file ordering.** `issueRootCard` takes a
  `revocationNonceOverride` seam precisely so suites don't make live chain reads; use it.
  A suite that passes only because another suite ran first and warmed a cached RPC client
  is not passing.

## Honesty about guarantees

This project's case rests on saying exactly what is established and what is not. An
on-chain receipt (`PaymentAnchor.anchorPayment`, written by KeeperHub on the chain the
payment settled on) establishes that the anchorer claimed the payment with exactly those
values; the payment itself is checked by opening `sourceTxHash` on the same chain. If you
change anything a user- or agent-facing surface says about a dry run, an execution or a
receipt, check that the MCP tool descriptions, `SECURITY.md` and the README still describe
what the code actually does. An agent relaying a receipt to a human should not be able to
overstate it.

## Pull requests

Keep them focused, make CI green, and say in the description what you verified and how.
If you deviate from an approach the docs describe, say why — a deviation with a reason is
welcome, a silent one is not.
