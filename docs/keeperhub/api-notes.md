# KeeperHub API notes

What the live API actually does, where it differs from the published docs, and what was
learned by calling it. `packages/engine/src/keeperhub/client.ts` points here.

Verified against `https://app.keeperhub.com/api` on 2026-09-16 with an organization
(`kh_`) key.

## Auth

`Authorization: Bearer kh_...`. Two probes, and they answer different questions:

| Probe | Tells you |
|---|---|
| `GET /api/keys` | the credential is valid and org-scoped — a `401` means wrong, revoked or absent |
| `GET /api/chains` | only that the host is reachable; it returns `200` with **no credential at all** |

Use `/api/keys` for a health check. `/api/chains` answering `200` proves nothing about
your key, which is exactly the trap a naive doctor script falls into.

## Plan gating — the one that bites

`GET /api/features` returns `{ plan, enabledFeatureIds, features[] }`. A feature is
usable when it names **no** `requiredPlan`, or when its id is in `enabledFeatureIds`.

**`enabled: true` on a feature does not mean your org may use it.** On a free org every
Pro feature still reads `enabled: true` alongside `requiredPlan: "pro"` — `enabled`
means "this build ships it". Reading that field alone lets a workflow through that the
API then rejects.

Pro-gated actions found in the catalogue:

```
HTTP Request · webhook/send-webhook · code/run-code · Database Query
blockscout/* · evm-chain/*
```

Everything that moves value is free: all 23 `web3/*` actions (`write-contract`,
`batch-write-contract`, `read-contract`, `sign-typed-data`, `transfer-token`,
`check-balance`, `query-events`, `assess-risk`, …) and all six triggers (Manual,
Schedule, Webhook, Event, Block, Transfer).

A workflow containing a gated action is rejected **whole**, with `402`:

```json
{ "error": "This workflow uses features that require a paid plan.",
  "code": "upgrade_required",
  "violations": [{ "featureId": "action.http-request", "requiredPlan": "pro",
                   "nodeIds": ["report"] }] }
```

`violations[].nodeIds` names the offending nodes, which is what makes it possible to
strip exactly those and retry. See `buildWorkflowDefinitions({ hooksEnabled })`.

## Workflow CRUD

- **Create is `POST /api/workflows/create`**, not `POST /api/workflows`. The latter
  answers `405`.
- `GET /api/workflows` lists; `PATCH /api/workflows/{id}` updates; `DELETE` removes.
- Created **disabled** by default. Schedule, event, block and webhook triggers do not
  fire until `enabled: true`. Manual workflows execute through the API regardless, so a
  disabled manual workflow is not a problem.

### Node config is strictly validated

Unknown fields are rejected with `422 INVALID_ACTION_CONFIG`, naming the field:

```json
{ "code": "UNKNOWN_FIELD", "path": "nodes[1].data.config.web3Connection",
  "message": "Unknown field \"web3Connection\" for action \"web3/write-contract\"." }
```

Two fields this repo previously sent are **not** in the schema, and every provision
failed until they were removed:

- `web3Connection` — the signing wallet is the org's, not a per-node choice
- `usePrivateMempool` — MEV-aware routing is a *chain* property
  (`usePrivateMempoolRpc` on `GET /api/chains`), not something a node declares

`GET /api/action-schemas` is the authoritative list; treat it, not the prose docs, as
the source of truth. For `web3/write-contract`:

| Required | Optional |
|---|---|
| `network`, `contractAddress`, `abi`, `abiFunction` | `ethValue`, `functionArgs`, `failOnError`, `gasLimitMultiplier` |

Templates are `{{@nodeId:Label.field}}`. Trigger inputs are spread at the **top level**
of the trigger output — there is no `body` or `data` wrapper — and the reference uses
the trigger node's real id. A label containing `:` breaks the syntax, so labels here
avoid it.

## Direct execution

`/api/execute/contract-call` takes `simulate: true` for a dry run — the JSON boolean,
not the string `"true"`. A successful simulation returns `success: true`,
`wouldRevert: false` and a `gasEstimate`; re-send the *same* body without `simulate`
and with an `Idempotency-Key` to broadcast.

A view/pure call does not return a simulation envelope. It returns its result, and
`success` may be `false` while `raw.result` holds the answer — so read `raw.result`
rather than branching on `success` for reads.

Poll `GET /api/execute/{executionId}/status`. `unconfirmed` is **not terminal**:
KeeperHub is still bumping gas and retrying. Treating it as failure surfaces a working
retry as an error.

## Idempotency

Writes retry only with an `Idempotency-Key`, so a retried send can only replay.
`idempotency_conflict` is never retryable; `idempotency_in_progress` is, with the
**same** key. A definite failure is replayed under the same key for 24h, which is why
`anchor.ts` moves a failed charge to a new key generation rather than reusing it.

## Gas sponsorship

`GET /api/gas-sponsorship` → `{ "enabled": true, "freeCents": 100, "label": "$1" }`.

Sponsorship pays the **fee only**, never the assets moved. It applies on Ethereum,
Base, Polygon, Arbitrum and their testnets, when the sender is the wallet itself (not a
Safe) and the route is the public mempool. Testnet usage is not charged against the
allowance.

It changes what the receipt looks like: `from` is the relayer and `to` is the
sponsorship wrapper, **not** your wallet and not the target contract. Verify a sponsored
transaction by the **log emitter** and the resulting state change; `receipt.to` will
mislead you. Both transactions in `proof-of-execution.md` were sponsored from a wallet
holding 0 ETH.

## Chains

24 chains at the time of writing: Ethereum, Sepolia, Base, Base Sepolia, Arbitrum,
Polygon, and others. **Creditcoin CC3 is not among them**, which is why the Attestcoin
proof's second leg stays on KeeperCard's direct RPC path.

## Cold starts

`create_workflow` and `ai_generate_workflow` can return `code: upstream_cold_start`
(HTTP 502/503/504) while the app wakes. Retry once or twice with the same
`idempotency_key` after `retryAfterSeconds`. Connection errors and DNS failures are
**not** cold starts and should not be retried as such.
