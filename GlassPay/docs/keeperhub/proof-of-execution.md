# Proof of execution — value moved through KeeperHub

Submission requirement #3 asks for a link to a transaction executed through KeeperHub.
This is that transaction, plus the checks that make it evidence rather than a claim.

## The transaction

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
AttestPay's own worker.

It does **not** demonstrate leg 2. `AttestPayASC.verifyPayment` runs on Creditcoin CC3,
and CC3 is not among KeeperHub's 24 supported chains — verified by reading
`GET /api/chains`. That leg stays on AttestPay's existing direct-RPC path, which is the
fallback the integration spec calls for rather than something faked.

The values above are a smoke-test payment (`cardId = 0xabab…`, memo
`keepercard smoke test`), not a customer charge.
