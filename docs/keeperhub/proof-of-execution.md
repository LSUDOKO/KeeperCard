# Proof of execution — value moved through KeeperHub

The submission asks for a link to a transaction executed through KeeperHub. These are
those transactions, plus the checks that make them evidence rather than claims.

Everything here is Base Sepolia (84532). Rows P1–P4 ran on the production deployment;
the rest on a local server against the live KeeperHub API. Re-check all of them with
`bun run --cwd packages/server verify:onchain`, which reads a public RPC and nothing else.
 Every check was made against a public RPC
(`https://sepolia.base.org`), not taken from KeeperHub's reply.

| # | What | KeeperHub workflow | Transaction |
|---|---|---|---|
| P1 | **Production** card payment, 0.02 USDC, paid by an agent over MCP | `card-payment-redemption` | [`0xcdc5ef72…17b75ed6`](https://sepolia.basescan.org/tx/0xcdc5ef7216fe80fea61f82d55da7f53208c2c98206ad0213f0269a2c17b75ed6) |
| P2 | ↳ on-chain receipt for P1, written unprompted ~40s later | `payment-receipt-anchor` | [`0x93a3f701…457615da`](https://sepolia.basescan.org/tx/0x93a3f70123e172a9e9f3f97ca8a1ac80654edfb961cf1e8a6bb133a6457615da) |
| P3 | **Production** card payment, 0.05 USDC | `card-payment-redemption` | [`0x28804b53…10ca40f7`](https://sepolia.basescan.org/tx/0x28804b5315f8ec86446bfdd62f7a30d76c157b13e33cb9ffedad8c0a10ca40f7) |
| P4 | ↳ on-chain receipt for P3 | `payment-receipt-anchor` | [`0x95c4f1f9…d6451d3d`](https://sepolia.basescan.org/tx/0x95c4f1f940d227a307e6e853ce6f830e5c1b50e8a1fc9bbc9349c38cd6451d3d) |
| 1 | Card payment, 0.01 USDC | `card-payment-redemption` · run `7pzmtv7kr2ar9kpwcua08` | [`0x54b1651c…f547b406`](https://sepolia.basescan.org/tx/0x54b1651ca19d7c557c028ef9d22949b609df4cff3dbdb3c4f3857e26f547b406) |
| 2 | Card payment, 0.02 USDC | `card-payment-redemption` | [`0x3c20c3d1…fe4d986b`](https://sepolia.basescan.org/tx/0x3c20c3d19a49a806bb95ecc9d3874cd73084368c3c22c54616d24205fe4d986b) |
| 3 | ↳ on-chain receipt for #2 | `payment-receipt-anchor` | [`0xaee6c910…bd55531e`](https://sepolia.basescan.org/tx/0xaee6c91062c90a332881ebf35780c2470a72e85ffd8bda78239d3465bd55531e) |
| 4 | Card payment, 0.06 USDC, risk-guarded | `guarded-card-payment` | [`0xc9368f9e…02fe0869`](https://sepolia.basescan.org/tx/0xc9368f9e49af1fc387f9ff2483cbb733ca5a53caacbc65fdd9a9913802fe0869) |
| 5 | ↳ on-chain receipt for #4 | `payment-receipt-anchor` | [`0x9ac752e2…0f50b24219`](https://sepolia.basescan.org/tx/0x9ac752e24178a9604c122c4d61dec1cc48027bb7e5c3a9f66f41a70f50b24219) |
| 6 | Direct USDC transfer, 1.50 USDC | direct execution | [`0x88a28cef…d945eb9`](https://sepolia.basescan.org/tx/0x88a28cef9cec59c8a7a298507ac2de19eac20e42b589dfb9734da9f15d945eb9) |

Workflows that ran without KeeperCard starting them:

| Workflow | Trigger | Evidence |
|---|---|---|
| `receipt-event-watcher` | Event | 4 successful runs, one per `PaymentAnchored` event (#3, #5, P2, P4) — started by the chain |
| `treasury-monitor` | Schedule | successful runs at KeeperHub's own 10-minute cron, reading real balances |
| `market-guard` | Schedule | read Chainlink USDC/USD `0.99987` and ETH/USD, evaluated the depeg Condition (`false`) |
| `fee-income-watcher` | Block | fired on its 900-block interval and read 18.04 USDC of collected fees from the org wallet |

---

## 1. What "verified" means here

A `202 Accepted` only proves KeeperHub queued work. A payment is treated as landed when:

- the receipt from a **public RPC** reports `status: 0x1`;
- the logs were emitted by the **expected contract** (USDC for a payment, `PaymentAnchor`
  for a receipt) — not inferred from `receipt.to`, which on a sponsored route is a wrapper;
- the **intended effect** is visible: balances moved, `isAnchored` flipped, the card's
  remaining budget dropped by exactly the sum of both legs.

## 2. A card payment (#1)

An agent called `keeperhub_dry_run`, got a `plan_id`, then called `pay` with it.

| | |
|---|---|
| Block | 46942073 · `gasUsed` 474847 · `status` 0x1 |
| Card account | `0xe02D720FE69Dd45C1F12dB8A97A0B30C17853AC8` (EIP-7702 upgraded by the sponsor) |
| KeeperHub run | `7pzmtv7kr2ar9kpwcua08` — `success` in KeeperHub's own execution history |

The receipt carries **two USDC `Transfer` events in one atomic transaction**, which is the
whole shape of a KeeperCard payment:

| From | To | Amount | What |
|---|---|---|---|
| `0xe02D72…3AC8` | `0x66b6…EC5a` | 0.010000 USDC | the merchant payment |
| `0xe02D72…3AC8` | `0x4F71…D441` | 0.010464 USDC | the gas-fee leg, to KeeperHub's wallet |

This moves value **under an ERC-7710 delegation**: the card's caveats were enforced
on-chain by the DelegationManager, the calldata was dry-run and reviewed first, and the
executed bytes are the reviewed bytes — the digest is carried from the dry run into the
idempotency key of the execution.

## 3. A risk-guarded payment (#4)

`KEEPERHUB_GUARDED_MIN_USDC=0.05` routed this 0.06 USDC payment to
`guarded-card-payment`. KeeperHub's step log for the run:

```
success  Redemption Request   {cardId, digest, calldata, functionArgs…}
success  Assess Risk          {riskScore: 70, factors: ["AI risk analysis failed — fail-closed"]}
success  Risk Acceptable      {"condition": true}            ← 70 < 90
success  Redeem Delegations   {chainId: 84532, sponsored: true, success: true}
```

The write node is only reachable through the Condition's `true` handle. Note what this
does and does not show: the assessor returned its fail-closed default (70), which passes
a ceiling of 90. It demonstrates the gate is wired and evaluated inside KeeperHub; it has
not yet demonstrated a *refusal*, which needs the assessor to return a critical verdict.

## 4. On-chain receipts (#3, #5)

After each payment confirmed, KeeperCard queued `payment-receipt-anchor` in the
background; about 25 seconds later the receipt was on-chain.

- both receipts: `status: 0x1`, one `PaymentAnchored` log **emitted by**
  `0x56733223c688cce7fc65826b692b3f8521e4ab3e`;
- the indexed `payer` topic is the card account that actually paid;
- `GET /api/keeperhub/attestation` — which reads the events back through KeeperHub's
  `query-events` and reconciles them with KeeperCard's ledger — reports
  `matched: 2, unwitnessed: 0, unrecorded: 0`.

A receipt is downstream of its payment by design: a slow or failing receipt can never
delay, fail, or roll back the payment it describes.

## 5. Gas: sponsored, and why receipts look odd

KeeperHub's gas sponsorship paid most of these fees through Turnkey's Gas Station, so a
receipt's `from` is a relayer and its `to` is a sponsorship wrapper — not our wallet, not
the target contract. That is expected on a sponsored route, and it is why verification
reads the **log emitter** and the **state change** instead of trusting `receipt.to`.

Sponsorship covers the *fee only*, and it can fall back to the wallet paying for itself.
The one failed run in this project's history was exactly that: KeeperHub's gas preflight
refused with `Insufficient BASE balance. Have: 0.0`. `treasury-monitor` now watches that
balance on a schedule and trips a Condition before it happens again.

## 6. Two fixes that had to land first

Both were found by testing against the live chain, and both are now covered by tests:

- **The EIP-7702 upgrade.** KeeperHub submits ordinary type-2 transactions, so a
  never-upgraded account cannot spend, and sponsorship does not cover a type-4
  authorization. `ATTESTPAY_7702_SPONSOR_PK` pays for it once per account (~46k gas).
- **Single call-type redemption.** Every caveat enforcer on a card chain is
  `onlySingleCallTypeMode`. A payment has two executions, and encoding them as one
  batch-mode entry reverted with `CaveatEnforcer:invalid-call-type` before any transfer —
  so no card payment could have succeeded. Each execution is now its own single-mode
  entry under the same delegation chain, still in one transaction.
