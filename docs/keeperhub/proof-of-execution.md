# Proof of execution — value moved through KeeperHub

Submission requirement #3 asks for a link to a transaction executed through KeeperHub.
These are those transactions, plus the checks that make them evidence rather than claims.

| What | Chain | Transaction |
|---|---|---|
| **Card payment via ERC-7710 delegation** | Base Sepolia | [`0x2e52bc36…a88ca755`](https://sepolia.basescan.org/tx/0x2e52bc363c82874b3ac085c0623f6a1ff62b10f79140d16c217b7a88a88ca755) |
| USDC transfer, 1.50 USDC | Base Sepolia | [`0x88a28cef…d945eb9`](https://sepolia.basescan.org/tx/0x88a28cef9cec59c8a7a298507ac2de19eac20e42b589dfb9734da9f15d945eb9) |
| `PaymentAnchor.anchorPayment` | Ethereum Sepolia | [`0x3eafda4b…c694a2f8`](https://sepolia.etherscan.io/tx/0x3eafda4b16c341b20de24d6868a4646c54881ab4f86a68941c5b69c3c694a2f8) |

---

## 0b. The same payment, executed by a provisioned workflow

Once `KEEPERHUB_WORKFLOW_PAY` was set on the API, the redemption stopped falling back to a
direct contract call and ran as a real workflow execution:

| | |
|---|---|
| Tx | [`0x54b1651c…f547b406`](https://sepolia.basescan.org/tx/0x54b1651ca19d7c557c028ef9d22949b609df4cff3dbdb3c4f3857e26f547b406) |
| KeeperHub run | `7pzmtv7kr2ar9kpwcua08` — `status: success` in KeeperHub's own execution history |
| Workflow | `card-payment-redemption` (`o6iijkcr7tj83nj8ufbx6`) |
| Block | 46942073 · `gasUsed` 474847 · `status` 0x1 |

Two USDC transfers again, in one transaction: 0.010000 to the merchant and 0.010464 as the
gas-fee leg. The distinction from §0 matters — this run is visible in KeeperHub's own
workflow history, not only in KeeperCard's ledger.

## 0. A card payment: the full product path

The one that matters most — an agent spending a scoped card, end to end, with KeeperHub
executing. `keeperhub_dry_run` → review the plan → `pay` with that `plan_id`.

| | |
|---|---|
| Chain | Base Sepolia (84532) |
| Tx | [`0x2e52bc36…a88ca755`](https://sepolia.basescan.org/tx/0x2e52bc363c82874b3ac085c0623f6a1ff62b10f79140d16c217b7a88a88ca755) |
| Block | 46941677 · `gasUsed` 449128 · `status` 0x1 |
| Card account | `0xe02D720FE69Dd45C1F12dB8A97A0B30C17853AC8` (EIP-7702 upgraded by the sponsor) |

The receipt carries **two USDC Transfer events in one atomic transaction**, which is the
whole shape of an AttestPay payment:

| From | To | Amount | What |
|---|---|---|---|
| `0xe02D72…3AC8` | `0x66b6…EC5a` | 0.010000 USDC | the merchant payment |
| `0xe02D72…3AC8` | `0x4F71…D441` | 0.010552 USDC | the gas-fee leg to KeeperHub's wallet |

The card's remaining budget moved `3 → 2.979448 USDC` — exactly the sum of both legs, so
the ledger and the chain agree.

### What this transaction proves that the others do not

The transfers below move value through KeeperHub directly. This one moves it **under an
ERC-7710 delegation**: the card's caveats were enforced on-chain by the DelegationManager,
the calldata was dry-run and reviewed first, and the executed bytes are the reviewed bytes.
That is the product, not just the rail.

Two fixes had to land before it could work, both found by testing against the live chain:

- **The EIP-7702 upgrade.** KeeperHub submits ordinary type-2 transactions, so a
  never-upgraded account cannot spend. Gas sponsorship does not cover a type-4
  authorization transaction, so `ATTESTPAY_7702_SPONSOR_PK` pays for it once per account.
- **Single call-type redemption.** Every caveat enforcer on a card chain is
  `onlySingleCallTypeMode`. A payment has two executions, and encoding them as one
  batch-mode entry reverted with `CaveatEnforcer:invalid-call-type` before any transfer
  happened — so no card payment could ever have succeeded. Each execution is now its own
  single-mode entry under the same delegation chain, still in one transaction.

---

## 1. USDC transfer on Base Sepolia — real value moved

The clearest proof: a token balance changed.

| | |
|---|---|
| Chain | Base Sepolia (84532) |
| Tx | [`0x88a28cef…d945eb9`](https://sepolia.basescan.org/tx/0x88a28cef9cec59c8a7a298507ac2de19eac20e42b589dfb9734da9f15d945eb9) |
| Token | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Amount | 1.50 USDC |
| KeeperHub execution | `ez4zskffia1iqmv3hjoz6` |
| Block | 46895042 · `gasUsed` 124050 |

Dry run first (`success: true`, `wouldRevert: false`, `gasEstimate: 62989`), then the
same call re-sent with an idempotency key.

Balances read from a public Base Sepolia RPC before and after:

| Account | Before | After |
|---|---|---|
| `0x4F71…D441` (org wallet) | 20.00 USDC | **18.50 USDC** |
| `0x66b6…EC5a` (recipient) | 0.00 USDC | **1.50 USDC** |

`status: 0x1`, and the single `Transfer` log was emitted by the USDC contract itself.
Money left one account and arrived in another — not a receipt, an actual transfer.

---

## 2. Cross-chain anchor on Ethereum Sepolia

### The transaction

| | |
|---|---|
| Chain | Ethereum Sepolia (11155111) |
| Tx | [`0x3eafda4b…c694a2f8`](https://sepolia.etherscan.io/tx/0x3eafda4b16c341b20de24d6868a4646c54881ab4f86a68941c5b69c3c694a2f8) |
| Contract | `PaymentAnchor` at `0x881c55745372DfCB7dEC9B13F499b167164e2121` |
| Function | `anchorPayment(cardId, payer, merchant, amount, sourceChainId, sourceTxHash, paidAt, memo)` |
| KeeperHub execution | `ymbc3rgnw1omtceswfhel` |
| Block | 11716364 |
| Workflow | `attestcoin-cross-chain-proof` (`625tzb9kz8wfg3okjjlch`), leg 1 of 2 |

## Dry run first, then the same call

The hackathon's theme is that nothing is re-inferred at execution time. The sequence run
here is KeeperHub's own documented safe-first-write order:

1. `simulateContractCall(...)` → `success: true`, `wouldRevert: false`, `gasEstimate: 74271`
2. the **same** arguments re-sent with an `idempotency_key` and no `simulate`
3. poll `directExecutionStatus` until terminal → `completed`

The arguments were not rebuilt between steps 1 and 2; step 2 re-sends the object step 1
validated. In the product path this is what `keeperhub_dry_run` → `pay(plan_id)` does,
with the calldata digest pinning the bytes (see `packages/engine/src/keeperhub/executor.ts`).

## Why this is verified, not just accepted

A `202` only proves KeeperHub queued work. Each of these was checked independently:

- **Receipt status** — `eth_getTransactionReceipt` against a public Sepolia RPC (not
  KeeperHub's word for it): `status: 0x1`, `gasUsed: 135451`.
- **The right contract emitted the event** — the single log's `address` is
  `0x881c…2121`, the PaymentAnchor itself.
- **The arguments are ours** — indexed topics decode to `cardId = 0xabab…abab`,
  `payer = merchant = 0x4F71…D441`.
- **The intended effect is visible on-chain** — `isAnchored(84532, sourceTxHash)`
  returned `false` before the call and `true` after. This is the check that actually
  matters: the state the contract exists to record did change.

## Gas: sponsored, and why the receipt looks odd

The org wallet `0x4F719186a5545B8dB9a8e3e2F31eDdfc55BaD441` held **0 ETH on every
chain** when this ran. KeeperHub's gas sponsorship paid the fee through Turnkey's Gas
Station, so the receipt's `from` is the relayer (`0x809d…0444`) and its `to` is the
sponsorship wrapper (`0x5af5…f07d`), not our wallet and not PaymentAnchor.

That indirection is expected on a sponsored route, and it is why the log emitter — not
`receipt.to` — is the field worth checking. Sponsorship covers the *fee only*; a call
that moved native value would still need that value in the wallet.

## What this does and does not demonstrate

It demonstrates leg 1 of the cross-chain proof: a payment anchored on Sepolia by
KeeperHub, with retries, nonce management and gas handled by KeeperHub rather than by
KeeperCard's own worker.

It does **not** demonstrate leg 2. `AttestPayASC.verifyPayment` runs on Creditcoin CC3,
and CC3 is not among KeeperHub's 24 supported chains — verified by reading
`GET /api/chains`. That leg stays on KeeperCard's existing direct-RPC path, which is the
fallback the integration spec calls for rather than something faked.

The values above are a smoke-test payment (`cardId = 0xabab…`, memo
`keepercard smoke test`), not a customer charge.
