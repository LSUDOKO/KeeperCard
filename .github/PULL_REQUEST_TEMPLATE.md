## What this changes

<!-- One or two sentences. What behaviour is different after this merges? -->

## Why

<!-- The problem. If this deviates from what the docs describe, say so and why. -->

## How it was verified

<!-- Commands you actually ran and what they said. "Should work" is not verification. -->

- [ ] `bun run test`
- [ ] `bun run typecheck`
- [ ] `cd contracts && forge test` (if contracts changed)
- [ ] `bun run --cwd packages/dashboard build` (if the dashboard changed)

## Guarantees

<!-- Delete if this touches nothing that bounds a spend or writes an on-chain receipt. -->

- [ ] This does not widen what a card may spend or what the project claims a receipt establishes.
- [ ] `SECURITY.md` and the README still describe what the code does.
