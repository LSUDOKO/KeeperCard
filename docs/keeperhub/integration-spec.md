# AttestPay × KeeperHub — Integration Spec

**Goal:** Turn AttestPay's own home-grown execution machinery (1Shot relayer calls, the reconcile sweep, the fiat settlement sweep, and the Attestcoin anchor/prove worker) into workflows executed through **KeeperHub**, while keeping AttestPay's actual differentiator — the ERC-7710 scoped delegation / caveat / card model — untouched.

**One-line framing for the submission:** *AttestPay decides what an agent is allowed to spend, on what terms, with what caveats. KeeperHub is now the thing that actually moves the money — deterministically, with retries, nonce management, MEV-aware routing, and a real audit trail — instead of AttestPay's own bespoke relayer/sweep code.*

This split is the whole pitch: **AttestPay = authorization layer. KeeperHub = execution layer.** Don't blur it — judges are explicitly scoring whether value *actually* moved through KeeperHub, not whether KeeperHub is bolted on cosmetically.

---

## 0. What KeeperHub actually gives you (confirm against `https://docs.keeperhub.com/` before building — this may drift)

- **MCP server**: `https://app.keeperhub.com/mcp` — agents create, dry-run, and execute workflows as tools.
- **CLI (`kh`)**: `kh workflow run <id> --wait`, `kh run status <run-id>`, `kh run logs <run-id>`, `kh execute contract-call ...`, `kh protocol list`.
- **REST API**: `https://app.keeperhub.com/api` — `/api/workflows` (CRUD), `/api/workflows/{id}/execute`, `/api/workflows/{id}/executions` (history), `/api/integrations`, `/api/chains`.
- **Workflow model**: nodes + edges, triggers (manual, scheduled, event-based), contract-call actions, conditional execution (`check_and_execute` — "send only if balance > X").
- **Reliability primitives**: nonce management for stuck transactions, Smart Gas Estimation, private/MEV-aware routing, retries with exponential backoff, non-custodial signing via Turnkey.
- **Multi-chain**: Ethereum Mainnet, Sepolia, Base, Arbitrum, and more (confirm Creditcoin CC3 testnet support — if unsupported, see §4 fallback).
- **Notification/integration nodes**: `discord`, `sendgrid`, `telegram`, `webhook`.
- **Observability**: Prometheus metrics at `/api/metrics`; per-run execution history and logs via API/CLI.
- **Dry run**: compose a workflow, review it, dry-run without touching the chain, then execute the *exact* reviewed workflow (no re-inference at execution time).

If Creditcoin CC3 isn't in KeeperHub's supported chain list, route only the Sepolia leg (anchoring) through KeeperHub and keep the Creditcoin leg on the existing direct-RPC path — say so explicitly in the submission's "what's unfinished" answer rather than faking it.

---

## 1. Code to REMOVE (replace with KeeperHub-executed workflows)

| Remove | Location | Why |
|---|---|---|
| 1Shot relayer call for delegation redemption | `packages/engine/src/spend.ts` (the `1Shot Public Relayer` call that invokes `DelegationManager.redeemDelegations`) | Replace with a KeeperHub contract-call workflow. KeeperHub's gas estimation, nonce management, MEV-aware routing and retry/backoff are a direct superset of what you need from a relayer. |
| Reconcile sweep worker | `packages/server` — `reconcile_sweep` (stuck-pending charge resolution, interval-based) | KeeperHub's built-in stuck-transaction nonce management + retry/backoff makes a bespoke sweep redundant. Delete the interval worker; let KeeperHub's run status answer "is this actually stuck." |
| Fiat settlement interval sweep | `packages/server` — `fiat_settle_sweep` (`ATTESTPAY_FIAT_SETTLE_INTERVAL_MS`) | Replace with a KeeperHub **scheduled trigger** workflow that periodically settles approved Visa charges on-chain. Moves a custom timer loop into KeeperHub's trigger system. |
| Attestcoin proof pipeline's background worker + SQLite state machine | `packages/engine/src/attestcoin/` — the `pending → anchoring → anchored → attested → proving → verified` sweep (`attestcoin_sweep`) | Replace with a multi-step KeeperHub workflow: node 1 = contract-call `PaymentAnchor.anchorPayment` (Sepolia), node 2 (triggered once attestor consensus is reached) = contract-call `AttestPayASC.verifyPayment` (Creditcoin, if supported — see §0 fallback). Keep the Solidity contracts exactly as-is; only the caller changes. |
| (Optional, lower priority) custom webhook delivery retry/backoff scheduler | `packages/server` events module | For *non-payment-critical* notifications only (e.g. `budget.low`), route through KeeperHub's `discord` / `telegram` / `sendgrid` / generic `webhook` integration nodes instead of your own HMAC-signed retry queue. **Keep your own signed webhook system for payment-critical events** — don't risk the core audit trail on a new dependency this close to a deadline. |

**Do NOT remove or touch:** the ERC-7710 caveat compiler, delegation issuance/signing flow, card/sub-card model, revocation layers (freeze/revoke/nuke), NL compiler, x402 facilitator, Attestcoin's trust model and Solidity contracts (`PaymentAnchor`, `AttestPayASC`, `ProvenTxDecoder`, `FactAnchor`, credit line / ledger / guarantee / passport contracts), credit scoring formula, OAuth lane, dashboard/Privy auth. That's the actual product. KeeperHub is not a replacement for any of it.

---

## 2. New KeeperHub workflows to build

Each of these becomes an actual KeeperHub workflow (nodes + edges), created either via the dashboard builder or agent-authored via the MCP server. Give each a stable `workflow_id` and wire it into the corresponding AttestPay code path.

### 2.1 `card-payment-redemption`
- **Trigger:** manual (invoked by AttestPay's `pay` MCP tool handler)
- **Nodes:** contract-call → `DelegationManager.redeemDelegations` on Base, with the pre-signed delegation chain as calldata
- **Replaces:** the 1Shot relayer call in `spend.ts`
- **Dry-run mode:** AttestPay's `pay` tool should call KeeperHub's dry-run first, surface the simulated result to the caller/card terms check, then execute the *same* reviewed workflow — this is literally the hackathon's core theme, implement it faithfully.
- **On success:** feed the KeeperHub `executionId` + tx hash into the existing charge ledger (memo, fee, tx hash) exactly as today, just sourced from KeeperHub's execution record instead of 1Shot's response.

### 2.2 `stuck-charge-recovery`
- **Trigger:** condition/event (or polled by AttestPay when a charge sits in `pending` past a threshold)
- **Nodes:** `check_and_execute`-style conditional re-submission with KeeperHub's own nonce management and backoff
- **Replaces:** `reconcile_sweep`

### 2.3 `fiat-settlement-sweep`
- **Trigger:** scheduled (replaces `ATTESTPAY_FIAT_SETTLE_INTERVAL_MS` timer)
- **Nodes:** read approved-but-unsettled Stripe charges (via a `webhook`/custom action calling back into AttestPay's own `/api` for the list) → contract-call the delegated USDC transfer on Base
- **Replaces:** `fiat_settle_sweep`

### 2.4 `attestcoin-cross-chain-proof`
- **Trigger:** event — fires on `onChargeConfirmed`
- **Nodes:**
  1. Contract-call `PaymentAnchor.anchorPayment(...)` on Ethereum Sepolia
  2. Wait/poll node for Attestcoin attestor consensus (or an external trigger once the prover API reports the height as attested)
  3. Contract-call `AttestPayASC.verifyPayment(height, txBytes, merkleProof, continuityProof)` on Creditcoin CC3 (if KeeperHub supports the chain — otherwise this node stays on the existing direct path and only node 1 moves to KeeperHub)
- **Replaces:** the custom `attestcoin_sweep` state machine
- **This is your strongest judging-criteria hit**: it's multi-chain, it's exactly the kind of "value movement triggered by one project, executed by KeeperHub, consumed by another (Creditcoin)" story the rubric asks for, and it gives you a very visible KeeperHub execution history + retry story for the reliability criterion.

### 2.5 `credit-line-draw-repay`
- **Trigger:** manual, invoked from the `draw_credit` / `repay_credit` MCP tools
- **Nodes:** contract-call through the ordinary `spend()` path (lender's funding card pays / borrower repays) with idempotency key passthrough
- **Dry-run first, then execute** — same pattern as §2.1. This is a good secondary example of "deterministic, reviewed, then exact execution" for the demo video, on a higher-stakes action than routine `pay`.

### 2.6 (optional) `notification-relay`
- **Trigger:** event (`budget.low`, `dispute.opened`, etc.)
- **Nodes:** `discord` / `telegram` / `sendgrid` integration node
- **Replaces:** part of the custom webhook retry queue for non-critical notifications only

---

## 3. New/changed MCP tools on AttestPay's side

Add these to the existing MCP tool table (`Agent Tools` section of the README) so the tool list itself documents the new execution surface:

| Tool | Purpose |
|---|---|
| `keeperhub_dry_run` | Compose and dry-run a payment/credit workflow through KeeperHub without touching the chain; returns the exact plan that would execute |
| `keeperhub_execution_status` | Look up a KeeperHub `executionId`'s status/logs for a given payment — surfaces in the dashboard next to the existing charge ledger entry |
| `keeperhub_audit_trail` | Pull KeeperHub's execution history for a card/account, merged alongside AttestPay's own audit log |

Update `pay`, `draw_credit`, `repay_credit`, and the internal reconcile/settlement/anchor paths to call these instead of the removed code in §1.

---

## 4. Environment variables to add

```
KEEPERHUB_API_KEY=            # kh_ prefixed key from app.keeperhub.com
KEEPERHUB_API_BASE=https://app.keeperhub.com/api
KEEPERHUB_MCP_URL=https://app.keeperhub.com/mcp
KEEPERHUB_WORKFLOW_PAY=        # workflow_id for card-payment-redemption
KEEPERHUB_WORKFLOW_RECOVERY=   # workflow_id for stuck-charge-recovery
KEEPERHUB_WORKFLOW_SETTLE=     # workflow_id for fiat-settlement-sweep
KEEPERHUB_WORKFLOW_ANCHOR=     # workflow_id for attestcoin-cross-chain-proof
KEEPERHUB_WORKFLOW_CREDIT=     # workflow_id for credit-line-draw-repay
KEEPERHUB_DRY_RUN_REQUIRED=1   # gate: refuse to execute without a prior dry-run in the same call chain
```

Remove/deprecate (mark as no-ops with a loud log line, don't hard-delete overnight in case rollback is needed):
```
ATTESTPAY_RECONCILE_INTERVAL_MS
ATTESTPAY_FIAT_SETTLE_INTERVAL_MS
ATTESTPAY_ATTESTCOIN_SWEEP_INTERVAL_MS
```

---

## 5. Observability changes

- Add a new SigNoz dashboard panel sourcing KeeperHub's Prometheus metrics (`/api/metrics`) alongside the existing AttestPay panels — workflow execution latency, retry counts, per-workflow success/failure rate.
- Add spans for `keeperhub.dry_run`, `keeperhub.execute`, `keeperhub.execution_poll` so the existing trace-per-hop philosophy (already used for the Attestcoin pipeline) extends cleanly to the new execution layer.
- Keep the existing typed-refusal logging (`refusal_reason`) for AttestPay-side policy refusals; add a parallel `keeperhub_execution_failed` log with the KeeperHub run's failure reason so the two failure domains (policy vs. execution) stay distinguishable in the audit log.

---

## 6. Testing checklist

- [ ] `pay` tool: dry-run → review → execute produces the *same* result KeeperHub previewed (no re-inference)
- [ ] A deliberately stuck/underpriced transaction recovers via `stuck-charge-recovery` without manual intervention
- [ ] `fiat-settlement-sweep` fires on schedule and settles at least one approved Visa charge on-chain
- [ ] `attestcoin-cross-chain-proof` anchors a real payment on Sepolia and (if supported) completes verification on Creditcoin CC3, visible in KeeperHub's execution history
- [ ] `credit-line-draw-repay` dry-runs and executes both a draw and a repayment with idempotency keys
- [ ] Server suite: assert that with `KEEPERHUB_API_KEY` unset, AttestPay falls back cleanly (or fails loudly, your choice — document which) rather than silently no-op'ing, mirroring the existing pattern for optional integrations like Attestcoin

---

## 7. Submission checklist (per the hackathon's stated requirements)

1. **Source code link** — this repo, with the changes above.
2. **Short demo video** showing: an agent calling `pay`, the KeeperHub dry-run preview, the executed workflow, and the resulting on-chain transaction.
3. **A link to a transaction executed through KeeperHub** — use `card-payment-redemption` or `attestcoin-cross-chain-proof` for this; pick whichever you get working most reliably first.
4. **Form answers to prepare:**
   - *Which project did you integrate with, and what does the integration do?* — AttestPay (agentic scoped payment cards); KeeperHub replaces AttestPay's relayer, reconcile sweep, fiat settlement sweep, and cross-chain proof worker as the execution layer underneath the existing delegation/caveat authorization model.
   - *Which KeeperHub surfaces did you use?* — MCP server, workflow dry-run/execute, contract-call nodes, scheduled/event triggers, execution history/audit trail (list only what you actually shipped).
   - *Testnet or mainnet?* — Base mainnet for payments (as AttestPay already runs), Sepolia/Creditcoin CC3 testnet for the Attestcoin leg — state this plainly, it matches AttestPay's own existing honesty pattern about what's simulated vs. real.
   - *What still breaks or is unfinished?* — be candid; the hackathon explicitly rewards this.

---

## 8. Suggested build order (for the agent doing the work)

1. Get a KeeperHub API key, confirm chain support for Base + Sepolia + (maybe) Creditcoin CC3 against `/api/chains`.
2. Build `card-payment-redemption` first (§2.1) — it's the single highest-value, most demo-able integration and directly replaces 1Shot.
3. Get one real transaction through it on Base mainnet (small amount) — this unblocks submission requirement #3 immediately.
4. Build `attestcoin-cross-chain-proof` (§2.4) next — it's your strongest differentiation for the judging rubric.
5. Only then tackle `stuck-charge-recovery`, `fiat-settlement-sweep`, `credit-line-draw-repay` if time remains — they strengthen the "survives non-happy-path" criterion but aren't required to have a working submission.
6. Record the demo video once §2.1 and §2.4 both work end-to-end.
