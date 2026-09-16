// The spend pipeline: validate (typed refusals, mirror of on-chain enforcement)
// -> carve leaf -> estimate (fee rebuild loop) -> send -> getStatus poll -> receipt.
//
// Validation mirrors the chain EXACTLY (fee-inclusive sums, fixed windows, subtree-wide,
// every ancestor checked) so agents get a clean refusal instead of a revert. The chain
// remains the backstop: anything the server gets wrong still reverts on-chain.

import { trace } from "@opentelemetry/api";
import { toFunctionSelector, type Address, type Hex } from "viem";
import { CHAIN_ID, CHAINS, FEE_COLLECTOR, publicClient, type ChainId } from "./chains";
import {
  allowanceLeafScope,
  allowancePinCaveats,
  applyOrArgs,
  canonicalSelector,
  contractLeafScope,
  declaredContractScope,
  decodeAllowanceCall,
  payLeafScope,
  type AllowanceCall,
} from "./compiler";
import { withAgentAccount } from "./custody";
import {
  carveLeafDelegation,
  erc20TransferExecution,
  feeExecution,
  has7702Code,
  signWithPrivateKey,
} from "./delegations";
import { EngineError, RefusalError } from "./errors";
import { atomsToUsdc, parseAtoms, usdcToAtoms } from "./money";
import { emitRefusalLog, emitChargeLog, usdcSpentTotal, chargesTotal } from "./telemetry";
import { executorVerifiesReceipts, type ExecutionPurpose, type Executor } from "./executor";
import { encodeRedemption } from "./keeperhub/calldata";
import type { RiskAssessment } from "./keeperhub/client";
import { parseKeeperHubRequestId, parsePlanContext } from "./keeperhub/executor";
import type { KeeperHubStore, SpendPlanRow } from "./keeperhub/store";
import type { RelayerTransaction } from "./relayer";
import { periodWindow, type CardRow, type ChargeKind, type ChargeRow, type Store } from "./store";
import type { CardState, Receipt, Wire7702Auth, WireDelegation, WireExecution } from "./types";

export type SpendMode = "pay" | "contract";

export type SpendRequest = {
  kind: ChargeKind;
  mode: SpendMode;
  /** pay mode */
  to?: Address;
  amountAtoms?: bigint;
  /** contract mode: pre-built work executions (server ABI-encodes upstream) */
  workExecutions?: WireExecution[];
  memo?: string;
  idempotencyKey?: string;
  /** INTERNAL (fiat settlement): drive an EXISTING charge row through the pipeline
   * instead of inserting a new one. Skips budget validation (the row already holds
   * the budget in the books) and never marks the row failed. */
  settleChargeId?: string;
  /** Selects the KeeperHub workflow that executes this redemption (pay by default). */
  purpose?: ExecutionPurpose;
  /** Execute a previously reviewed plan (planSpend) byte-for-byte instead of carving
   * a fresh redemption. The plan's own terms win; to/amount/memo here are ignored. */
  planId?: string;
};

/** A reviewed, dry-run redemption: exactly what will execute if the agent approves it. */
export type SpendPlan = {
  status: "planned";
  plan_id: string;
  card_id: string;
  digest: Hex;
  executor: Executor["kind"];
  workflow: ExecutionPurpose;
  to: Address | null;
  amount: string;
  fee: string;
  total: string;
  memo?: string;
  simulation: {
    engine: Executor["kind"];
    would_revert: false;
    gas_estimate: string | null;
    simulated_at: number | null;
    redeemer: Address;
    execution_count: number;
  };
  remaining_this_period_after: string | null;
  expires_at: number;
  /**
   * KeeperHub's advisory risk read on this exact calldata, when the executor provides
   * one. `advisory: true` means the assessor did not reach a verdict (its backend
   * failed) and `level` is a fail-closed placeholder — show it, do not act on it.
   */
  risk?: RiskAssessment | null;
};

export type SpendDeps = {
  store: Store;
  /** The execution layer: KeeperHubExecutor by default, the legacy 1Shot Relayer on rollback. */
  relayer: Executor;
  /** Reviewed-plan storage (KeeperHub dry-run -> execute). Required for planSpend / planId. */
  plans?: KeeperHubStore | null;
  /** How long a reviewed plan stays executable (seconds, default 600). */
  planTtlSeconds?: number;
  chainId?: ChainId;
  now?: () => number;
  /** test seam: overrides the on-chain getCode check */
  codeCheck?: (address: Address, chainId: ChainId) => Promise<boolean>;
  /** test seam: overrides the live account-nonce read (stale-7702-auth guard) */
  accountNonce?: (address: Address, chainId: ChainId) => Promise<number>;
  /** confirm inclusion via chain logs (default: on for the 1Shot lane, off for KeeperHub, whose
   * status already reports receipts re-fetched from the chain; tests with a fake relayer set false) */
  confirmViaChain?: boolean;
  /** fee-uniqueness jitter source (default random 0-999 atoms; tests pin it) */
  feeJitter?: (baseAtoms: bigint) => bigint;
  /** Called once whenever a charge reaches 'confirmed', from ANY path: the inline
   * confirm below and the reconcile sweep both fire it. The Attestcoin integration
   * hangs off this to enqueue cross-chain verification.
   *
   * Must be cheap, synchronous and non-throwing — it is invoked on the payment's
   * critical path, and bookkeeping must never be able to fail a payment that has
   * already landed on-chain. Callers are shielded by a try/catch regardless. */
  onChargeConfirmed?: (chargeId: string, cardId: string) => void;
};

/** Fires `onChargeConfirmed`, swallowing anything it throws.
 * A downstream queue being broken is not a reason to fail a confirmed payment. */
function notifyConfirmed(deps: SpendDeps, chargeId: string, cardId: string): void {
  if (!deps.onChargeConfirmed) return;
  try {
    deps.onChargeConfirmed(chargeId, cardId);
  } catch {
    /* bookkeeping hook must never break a confirmed payment */
  }
}

const ESTIMATE_RETRIES = 3;

/** Fee uniqueness jitter: every redemption pays minFee + [0..999] atoms (max 0.000999
 * USDC) so the fee-leg Transfer log (from, to=feeCollector, value) is a per-spend
 * fingerprint. confirmRedemption matches on it; without this, two same-fee spends in
 * overlapping block windows are indistinguishable (live M2 finding). */
export function jitteredFee(baseAtoms: bigint): bigint {
  return baseAtoms + BigInt(crypto.getRandomValues(new Uint32Array(1))[0]! % 1000);
}

// ---------------------------------------------------------------------------
// Status / chain helpers
// ---------------------------------------------------------------------------

export function assertChainSpendable(chain: CardRow[], now: number): void {
  for (const card of chain) {
    if (card.status === "frozen") {
      emitRefusalLog(card.id, "card_frozen", "0");
      throw new RefusalError("card_frozen", `card ${card.id === chain[0]!.id ? "" : "(ancestor) "}is frozen`, { card_id: card.id });
    }
    if (card.status === "revoked" || card.status === "nuked") {
      emitRefusalLog(card.id, "card_revoked", "0");
      throw new RefusalError("card_revoked", "card has been revoked", { card_id: card.id });
    }
    if (card.terms.expiry !== undefined && now >= card.terms.expiry) {
      emitRefusalLog(card.id, "card_expired", "0");
      throw new RefusalError("card_expired", "card has expired", { card_id: card.id, expired_at: card.terms.expiry });
    }
  }
}

/** A card's wire delegation with composite OR-args applied for this redemption's mode. */
export function delegationForMode(card: CardRow, mode: SpendMode): WireDelegation {
  if (!card.compiled.orGroups) return card.delegation;
  return { ...card.delegation, caveats: applyOrArgs(card.compiled, mode) };
}

/** Resolve the authorizationList for a not-yet-7702-coded delegator from the stored
 * auth, REFUSING if the account nonce has advanced past the signed nonce: a 7702
 * authorization is single-nonce, so a stale one is guaranteed to revert on-chain.
 * The user heals it by re-onboarding (the dashboard re-signs a fresh auth on login). */
export async function resolveStoredAuth(
  stage: string,
  user: { address: string; auth7702_json: string | null },
  chainId: ChainId,
  accountNonce?: (address: Address, chainId: ChainId) => Promise<number>,
): Promise<Wire7702Auth[]> {
  if (!user.auth7702_json) {
    throw new EngineError(stage, "user not 7702-coded and no stored authorization");
  }
  const auth = JSON.parse(user.auth7702_json) as Wire7702Auth;
  let live: number | null = null;
  try {
    live = await (accountNonce ??
      ((a: Address, cid: ChainId) => publicClient(cid).getTransactionCount({ address: a })))(
      user.address as Address,
      chainId,
    );
  } catch {
    // RPC blip: proceed with the stored auth — the relayer pre-simulates and the chain backstops
  }
  if (live !== null && BigInt(auth.nonce) !== BigInt(live)) {
    throw new RefusalError(
      "invalid_terms",
      "stored 7702 authorization is stale (the account nonce advanced past the signed nonce) — sign in on the dashboard to refresh it",
      { signed_nonce: BigInt(auth.nonce).toString(), account_nonce: live.toString() },
    );
  }
  return [auth];
}

// ---------------------------------------------------------------------------
// Validation (the refusal engine)
// ---------------------------------------------------------------------------

export function validateSpend(
  deps: SpendDeps,
  chain: CardRow[],
  req: SpendRequest,
  totalAtoms: bigint, // amount + fee (what the enforcers will actually count)
  now: number,
): void {
  const card = chain[0]!;

  if (req.mode === "pay") {
    if (!req.to || req.amountAtoms === undefined) {
      emitRefusalLog(card.id, "invalid_terms", "0");
      throw new RefusalError("invalid_terms", "pay requires to + amount");
    }
    if (req.amountAtoms <= 0n) {
      emitRefusalLog(card.id, "invalid_terms", "0");
      throw new RefusalError("invalid_terms", "amount must be > 0");
    }
    // merchant whitelist: every card in the chain that carries one must allow `to`
    for (const c of chain) {
      const merchants = c.compiled.carvePolicy.merchants;
      if (merchants && !merchants.some((m) => m.toLowerCase() === req.to!.toLowerCase())) {
        emitRefusalLog(c.id, "merchant_not_allowed", atomsToUsdc(req.amountAtoms!));
        throw new RefusalError("merchant_not_allowed", `recipient ${req.to} is not on the card's merchant list`, {
          card_id: c.id,
        });
      }
    }
    // per-tx max: tightest in the chain governs (work amount, not fee)
    for (const c of chain) {
      const cap = c.compiled.carvePolicy.perTxMaxAtoms;
      if (cap !== null && req.amountAtoms > cap) {
        emitRefusalLog(c.id, "per_tx_exceeded", atomsToUsdc(req.amountAtoms));
        throw new RefusalError("per_tx_exceeded", `amount exceeds the per-charge max of ${atomsToUsdc(cap)} USDC`, {
          card_id: c.id,
          per_tx_max: atomsToUsdc(cap),
        });
      }
    }
  } else {
    // contract mode: this card must carry contract scope; targets/methods subset check
    if (!card.terms.contract) {
      emitRefusalLog(card.id, "target_not_allowed", "0");
      throw new RefusalError("target_not_allowed", "this card has no contract capability");
    }
    const execs = req.workExecutions ?? [];
    if (!execs.length) {
      emitRefusalLog(card.id, "invalid_terms", "0");
      throw new RefusalError("invalid_terms", "execute requires at least one call");
    }
    // ERC-20 allowance grants (approve/increaseAllowance) get extra gates here and
    // exact on-chain pins downstream; throws invalid_terms on malformed calldata.
    const allowances = execs.map((e) => decodeAllowanceCall(e));
    const usdcAddr = CHAINS[deps.chainId ?? CHAIN_ID].usdc.toLowerCase();
    for (const c of chain) {
      if (!c.terms.contract) continue; // pay-only ancestors govern via OR groups / caps on-chain
      // Validate against the DECLARED scope, not the fee-safe one: a card scoped to
      // (say) Uniswap must NOT also permit USDC.transfer just because the fee leg unions
      // those in on-chain. Every ancestor's declared scope must allow every target AND
      // selector (engine-level gate, mirroring the MCP tool's encodeScopedCall check, so
      // any future non-MCP caller that hand-builds workExecutions can't bypass it).
      const declared = declaredContractScope(c.terms.contract);
      const allowedTargets = new Set(declared.targets.map((t) => t.toLowerCase()));
      const allowedSelectors = new Set(
        declared.selectors.flatMap((s) => {
          try {
            return [toFunctionSelector(canonicalSelector(s)).toLowerCase()];
          } catch {
            return []; // a malformed legacy/stored selector matches no real calldata; skip it
          }
        }),
      );
      for (const [i, e] of execs.entries()) {
        if (!allowedTargets.has(e.target.toLowerCase())) {
          emitRefusalLog(c.id, "target_not_allowed", "0");
          throw new RefusalError("target_not_allowed", `target ${e.target} is outside the card's contract scope`, {
            card_id: c.id,
            target: e.target,
          });
        }
        const selector = (e.data ?? "0x").slice(0, 10).toLowerCase();
        if (!allowedSelectors.has(selector)) {
          emitRefusalLog(c.id, "method_not_allowed", "0");
          throw new RefusalError("method_not_allowed", `selector ${selector} is outside the card's contract scope`, {
            card_id: c.id,
            selector,
          });
        }
        if (e.value && e.value !== "0") {
          emitRefusalLog(c.id, "invalid_terms", "0");
          throw new RefusalError("invalid_terms", "native value is not supported on contract cards");
        }
        // allowance gates: spender stays inside the declared call surface; token list +
        // per-trade USDC cap apply per ancestor that declares them (tightest governs)
        const al = allowances[i];
        if (!al) continue;
        if (!allowedTargets.has(al.spender.toLowerCase())) {
          emitRefusalLog(c.id, "spender_not_allowed", atomsToUsdc(al.amountAtoms));
          throw new RefusalError("spender_not_allowed", `allowance spender ${al.spender} is outside the card's contract scope`, {
            card_id: c.id,
            spender: al.spender,
          });
        }
        const tokens = c.terms.contract.tokens;
        if (tokens && !tokens.some((t) => t.toLowerCase() === al.token.toLowerCase())) {
          emitRefusalLog(c.id, "token_not_allowed", atomsToUsdc(al.amountAtoms));
          throw new RefusalError("token_not_allowed", `token ${al.token} is not on the card's allowance token list`, {
            card_id: c.id,
            token: al.token,
          });
        }
        const cap = c.terms.contract.perTradeMax;
        if (cap !== undefined && al.token.toLowerCase() === usdcAddr && al.amountAtoms > usdcToAtoms(cap)) {
          emitRefusalLog(c.id, "per_trade_exceeded", atomsToUsdc(al.amountAtoms));
          throw new RefusalError("per_trade_exceeded", `allowance exceeds the per-trade max of ${cap} USDC`, {
            card_id: c.id,
            per_trade_max: cap,
            requested: atomsToUsdc(al.amountAtoms),
          });
        }
      }
    }
  }

  // uses (limitedCalls mirror): subtree-wide per ancestor
  for (const c of chain) {
    if (c.terms.maxUses !== undefined) {
      const used = deps.store.subtreeUsesCount(c.id);
      if (used >= c.terms.maxUses) {
        emitRefusalLog(c.id, "uses_exhausted", "0");
        throw new RefusalError("uses_exhausted", `card has used all ${c.terms.maxUses} redemptions`, { card_id: c.id });
      }
    }
  }

  // money caps: fee-inclusive, fixed windows, subtree-wide, every ancestor
  for (const c of chain) {
    const pay = c.terms.pay;
    if (!pay) continue;
    if (pay.period && c.compiled.periodStartDate !== null) {
      const w = periodWindow(c.compiled.periodStartDate, pay.period.seconds, now);
      const spent = deps.store.subtreeSpentSince(c.id, w.start);
      const cap = usdcToAtoms(pay.period.amount);
      if (spent + totalAtoms > cap) {
        emitRefusalLog(c.id, "over_period_limit", atomsToUsdc(totalAtoms));
        throw new RefusalError(
          "over_period_limit",
          `this charge (incl. ${atomsToUsdc(totalAtoms - (req.amountAtoms ?? 0n))} fee) exceeds the period budget`,
          {
            card_id: c.id,
            remaining_this_period: atomsToUsdc(cap > spent ? cap - spent : 0n),
            period_resets_at: w.resetsAt,
          },
        );
      }
    }
    if (pay.lifetime) {
      const spent = deps.store.subtreeSpentLifetime(c.id);
      const cap = usdcToAtoms(pay.lifetime.amount);
      if (spent + totalAtoms > cap) {
        emitRefusalLog(c.id, "over_lifetime_limit", atomsToUsdc(totalAtoms));
        throw new RefusalError("over_lifetime_limit", "this charge exceeds the card's lifetime budget", {
          card_id: c.id,
          remaining_lifetime: atomsToUsdc(cap > spent ? cap - spent : 0n),
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Estimate-error -> refusal mapping (chain said no; translate when we can)
// ---------------------------------------------------------------------------

function refusalFromEstimateError(err: string, mode: SpendMode): RefusalError | null {
  if (/PeriodTransferEnforcer/i.test(err)) return new RefusalError("over_period_limit", `chain refused: ${err}`);
  if (/TransferAmountEnforcer/i.test(err)) return new RefusalError("over_lifetime_limit", `chain refused: ${err}`);
  if (/TimestampEnforcer/i.test(err)) return new RefusalError("card_expired", `chain refused: ${err}`);
  if (/LimitedCallsEnforcer/i.test(err)) return new RefusalError("uses_exhausted", `chain refused: ${err}`);
  if (/AllowedTargetsEnforcer/i.test(err)) return new RefusalError("target_not_allowed", `chain refused: ${err}`);
  if (/AllowedMethodsEnforcer/i.test(err)) return new RefusalError("method_not_allowed", `chain refused: ${err}`);
  // pay-mode calldata caveats are recipient pins; contract-mode ones are the server's
  // OWN allowance pins (built from the validated request), so a mismatch there is an
  // engine fault, not an agent-facing refusal -> fall through to EngineError.
  if (/AllowedCalldataEnforcer/i.test(err)) {
    return mode === "pay" ? new RefusalError("merchant_not_allowed", `chain refused: ${err}`) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Confirmation: chain logs are the TRUTH; relayer getStatus is a hint.
// Every redemption carries the mandatory fee transfer (delegator -> feeCollector),
// so a USDC Transfer log matching (from, to=feeCollector, value=fee) since the
// send block IS the inclusion proof, redemption-shape-independent.
// ---------------------------------------------------------------------------

export async function confirmRedemption(
  relayer: Pick<Executor, "getStatus">,
  args: {
    requestId: string;
    delegator: Address;
    feeAtoms: bigint;
    sinceBlock: bigint;
    chainId?: ChainId;
    /** the collector this redemption actually paid (feeData.feeCollector); the constant is a stale fallback */
    feeCollector?: Address;
  },
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<{ status: "confirmed" | "failed" | "pending"; txHash: Hex | null }> {
  const chainId = args.chainId ?? CHAIN_ID;
  const pub = publicClient(chainId);
  const usdc = CHAINS[chainId].usdc;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  const interval = opts.intervalMs ?? 2_000;

  while (Date.now() < deadline) {
    // 1) relayer hint (fast-path on a clean success)
    const st = await relayer.getStatus(args.requestId);
    if (st.status === 200) return { status: "confirmed", txHash: st.txHash };
    // 2) chain truth: the fee-leg Transfer event is the inclusion proof, independent of
    // the relayer status. Check it BEFORE trusting a 500 — a relayer-side error (or a lag)
    // must not flip an already-included redemption to "failed".
    try {
      const logs = await pub.getLogs({
        address: usdc,
        event: {
          type: "event",
          name: "Transfer",
          inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
          ],
        },
        args: { from: args.delegator, to: args.feeCollector ?? FEE_COLLECTOR },
        fromBlock: args.sinceBlock,
      });
      const hit = logs.find((l) => (l.args as { value?: bigint }).value === args.feeAtoms);
      if (hit) return { status: "confirmed", txHash: hit.transactionHash };
    } catch {
      // RPC blip: keep polling
    }
    // relayer says failed AND no on-chain fee-leg exists -> a genuine revert
    if (st.status === 500) return { status: "failed", txHash: st.txHash };
    await new Promise((r) => setTimeout(r, interval));
  }
  return { status: "pending", txHash: null };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** The executor's redeeming address. Fakes that predate the Executor seam fall back to
 * the chain's legacy relayer target, which is what they were written against. */
async function redeemerFor(executor: Executor, chainId: ChainId): Promise<Address> {
  return typeof executor.delegateAddress === "function"
    ? await executor.delegateAddress()
    : CHAINS[chainId].targetAddress;
}

/** Pay / contract spend: validate -> dry run -> execute -> confirm -> receipt. */
export async function spend(deps: SpendDeps, cardId: string, req: SpendRequest): Promise<Receipt> {
  return (await runSpend(deps, cardId, req, false)) as Receipt;
}

/** Dry-run a spend WITHOUT executing it. Validates against the card's terms exactly as
 * spend() would, carves and signs the redemption, simulates it through the executor
 * (KeeperHub `simulate: true` from the org wallet), and stores the signed bytes as a
 * plan. `spend(..., { planId })` later executes those same bytes, or nothing. */
export async function planSpend(deps: SpendDeps, cardId: string, req: SpendRequest): Promise<SpendPlan> {
  if (req.settleChargeId) throw new EngineError("plan", "settlement charges cannot be planned");
  if (req.planId) throw new EngineError("plan", "a plan cannot be planned again");
  return (await runSpend(deps, cardId, req, true)) as SpendPlan;
}

async function runSpend(deps: SpendDeps, cardId: string, req: SpendRequest, planOnly: boolean): Promise<Receipt | SpendPlan> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  const store = deps.store;

  // reviewed-plan execution: the plan's terms replace the request's, and the signed
  // redemption inside it is what gets sent (no re-carve, no re-simulation)
  let preplanned: SpendPlanRow | null = null;
  if (req.planId) {
    if (!deps.plans) throw new EngineError("plan", "reviewed plans are not available on this executor");
    if (req.settleChargeId) throw new EngineError("plan", "settlement charges cannot execute a plan");
    const plan = deps.plans.getPlan(req.planId);
    if (!plan || plan.card_id !== cardId) throw new EngineError("plan", "no such plan for this card");
    if (plan.status === "executed" && plan.charge_id) {
      const row = store.getCharge(plan.charge_id);
      if (row) {
        return receiptFromCharge(deps, cardId, row.status, row.tx_hash, row.to_addr ?? FEE_COLLECTOR, row.amount_atoms, row.fee_atoms, now, row.memo ?? undefined);
      }
    }
    if (plan.status !== "open") throw new EngineError("plan", `plan is ${plan.status}; dry-run again`);
    if (plan.expires_at <= now) {
      deps.plans.setPlanStatus(plan.id, "expired");
      throw new EngineError("plan", "plan expired before it was executed; dry-run again");
    }
    preplanned = plan;
    req = {
      ...req,
      kind: plan.kind,
      mode: plan.mode,
      to: plan.to_addr ?? undefined,
      amountAtoms: plan.amount_atoms,
      memo: plan.memo ?? undefined,
      idempotencyKey: plan.idempotency_key ?? undefined,
    };
  }

  // settlement mode: re-drive an EXISTING charge row (the fiat leg). The webhook's
  // atomic decide+insert already booked the row against the budget; this pass only
  // executes the on-chain transfer for it.
  let settleRow: ChargeRow | null = null;
  if (req.settleChargeId) {
    const row = store.getCharge(req.settleChargeId);
    if (!row || row.card_id !== cardId) {
      throw new EngineError("settle", "no such settlement charge for this card");
    }
    if (row.status === "confirmed" || row.status === "failed" || row.status === "settlement_unconfirmed") {
      // terminal: replay the row as a receipt, no new attempt
      return receiptFromCharge(deps, cardId, row.status, row.tx_hash, row.to_addr ?? FEE_COLLECTOR, row.amount_atoms, row.fee_atoms, now, row.memo ?? undefined);
    }
    if (row.request_id !== null) {
      // a previous attempt already broadcast: re-sending risks a double-spend.
      // The reconcile sweep owns the row from here.
      return receiptFromCharge(deps, cardId, "pending", row.tx_hash, row.to_addr ?? FEE_COLLECTOR, row.amount_atoms, row.fee_atoms, now, row.memo ?? undefined);
    }
    if (!row.to_addr) throw new EngineError("settle", "settlement charge has no recipient");
    // pending, never broadcast: adopt the row's terms and run the normal pipeline
    settleRow = row;
    req = { ...req, to: row.to_addr, amountAtoms: row.amount_atoms, kind: row.kind, mode: "pay", memo: row.memo ?? undefined };
  }

  // idempotency replay (settle mode replays against the row above)
  if (req.idempotencyKey && !settleRow) {
    const existing = store.chargeByIdempotency(cardId, req.idempotencyKey);
    if (existing) {
      // A charge that FAILED before it was ever broadcast (request_id null) was never
      // sent on-chain — retrying the same key must re-attempt, not seal the failure.
      // A failure WITH a request_id might have landed on-chain, so it stays terminal.
      if (existing.status === "failed" && existing.request_id === null) {
        store.deleteCharge(existing.id); // clear the dead row so the unique idem index frees up
      } else {
        return receiptFromCharge(deps, cardId, existing.status, existing.tx_hash, existing.to_addr ?? req.to ?? FEE_COLLECTOR, existing.amount_atoms, existing.fee_atoms, now, existing.memo ?? undefined);
      }
    }
  }

  const chain = store.ancestorChain(cardId);
  if (!chain.length) {
    emitRefusalLog(cardId, "card_not_found", "0");
    throw new RefusalError("card_not_found", "no such card");
  }
  const card = chain[0]!;
  assertChainSpendable(chain, now);

  const user = store.getUser(chain[chain.length - 1]!.user_id);
  if (!user) throw new EngineError("spend", "card has no user row");

  // fee planning: start at minFee (+uniqueness jitter), rebuild if the executor asks for more.
  // A reviewed plan already carries its fee inside the signed leaf.
  const jitter = deps.feeJitter ?? jitteredFee;
  const feeData = preplanned ? null : await deps.relayer.getFeeData(CHAINS[chainId].usdc);
  let feeAtoms = preplanned ? preplanned.fee_atoms : jitter(usdcToAtoms(feeData!.minFee));

  const amountAtoms = req.amountAtoms ?? 0n;
  const workExecutions: WireExecution[] =
    req.mode === "pay"
      ? [erc20TransferExecution(CHAINS[chainId].usdc, req.to!, amountAtoms)]
      : (req.workExecutions ?? []);

  // contract-mode work execution VALUE total counts nothing in USDC terms; the on-chain
  // budget for contract cards is the scope itself. Pay caps still count amount+fee.
  // Settle mode skips validation: the webhook already decided this charge against the
  // books and the row itself holds the budget; re-validating would double-count it.
  // The chain remains the backstop.
  if (!settleRow) validateSpend(deps, chain, req, amountAtoms + feeAtoms, now);

  // authorizationList: only until A_user's 7702 code lands (stale-nonce-guarded)
  const codeCheck = deps.codeCheck ?? has7702Code;
  let authorizationList: Wire7702Auth[] | undefined;
  if (!(await codeCheck(user.address as Address, chainId))) {
    authorizationList = await resolveStoredAuth("spend", user, chainId, deps.accountNonce);
  }
  const redeemer = preplanned ? null : await redeemerFor(deps.relayer, chainId);

  const chainDelegations = chain.map((c) => delegationForMode(c, req.mode));

  // Per-redemption transaction items. Pay mode = one item (work + fee), exactly the
  // proven shape. Contract mode ISOLATES every ERC-20 allowance call in its own item
  // behind a pinned leaf (exact spender + amount): a caveat is evaluated against every
  // execution in its item, so the pin must never see the swap/fee legs (Phase-B SEND #3
  // + probe-multiitem, live-verified). All items ride ONE relayer send -> one atomic tx.
  const planItems = (): Array<{ executions: WireExecution[]; pin: AllowanceCall | null }> => {
    if (req.mode === "pay") return [{ executions: [...workExecutions], pin: null }];
    const items: Array<{ executions: WireExecution[]; pin: AllowanceCall | null }> = [];
    let run: WireExecution[] = [];
    for (const e of workExecutions) {
      const allowance = decodeAllowanceCall(e);
      if (allowance) {
        if (run.length) {
          items.push({ executions: run, pin: null });
          run = [];
        }
        items.push({ executions: [e], pin: allowance });
      } else {
        run.push(e);
      }
    }
    if (run.length) items.push({ executions: run, pin: null });
    return items;
  };

  // estimate loop: carve -> estimate -> (fee mismatch? rebuild) -> send
  let lastError: string | null = null;
  for (let attempt = 0; attempt < ESTIMATE_RETRIES; attempt++) {
    let transactions: RelayerTransaction[];
    // the executor's own shape, so an added field (e.g. `risk`) is visible here
    let est: Awaited<ReturnType<Executor["estimate"]>>;
    if (preplanned) {
      // the reviewed bytes, verbatim; the executor re-checks the digest against the dry run
      transactions = preplanned.transactions;
      // no fresh dry run on this path: the plan already holds a reviewed simulation
      est = { success: true, error: null, requiredPaymentAmount: null, context: preplanned.context, raw: null };
    } else {
      const items = planItems();
      // the fee leg rides the last item if unpinned, else its own normal-leaf item
      // (a pinned item must hold ONLY its allowance execution)
      // feeCollector is chain-specific and the relayer owns the truth (it is returned by
      // relayer_getFeeData, already fetched above). The FEE_COLLECTOR constant went stale
      // on both chains; paying the wrong collector makes the relayer refuse the estimate.
      const feeExec = feeExecution(feeData!.feeCollector ?? FEE_COLLECTOR, feeAtoms, chainId);
      const last = items.at(-1);
      if (last && !last.pin) last.executions.push(feeExec);
      else items.push({ executions: [feeExec], pin: null });

      transactions = [];
      for (const item of items) {
        const scope =
          req.mode === "pay"
            ? payLeafScope(amountAtoms + feeAtoms, chainId)
            : item.pin
              ? allowanceLeafScope(item.pin)
              : contractLeafScope(card.terms.contract!, chainId);
        const leaf = await withAgentAccount(card.k_agent_enc, async (_account, pk) =>
          signWithPrivateKey(
            pk,
            carveLeafDelegation({
              parent: chainDelegations[0]!,
              from: card.k_agent_address,
              scope: scope as never,
              extraCaveats: item.pin ? allowancePinCaveats(item.pin, chainId) : undefined,
              chainId,
              delegate: redeemer!,
            }),
            chainId,
          ),
        );
        transactions.push({ permissionContext: [leaf, ...chainDelegations], executions: item.executions });
      }
      est = await deps.relayer.estimate(transactions, authorizationList);

      if (!est.success) {
        lastError = est.error;
        const refusal = est.error ? refusalFromEstimateError(est.error, req.mode) : null;
        if (refusal) throw refusal;
        const lane = deps.relayer.kind === "keeperhub" ? "KeeperHub dry run" : "relayer estimate";
        throw new EngineError("estimate", `${lane} failed: ${est.error ?? "unknown"}`);
      }

      const required = est.requiredPaymentAmount ? parseAtoms(est.requiredPaymentAmount) : feeAtoms;
      if (required > feeAtoms) {
        feeAtoms = jitter(required);
        // re-check budgets with the real fee before retrying (skip in settle mode)
        if (!settleRow) validateSpend(deps, chain, req, amountAtoms + feeAtoms, now);
        continue;
      }
    }

    if (!est.context) throw new EngineError("estimate", "estimate succeeded but returned no context");

    if (planOnly) {
      if (!settleRow) validateSpend(deps, chain, req, amountAtoms + feeAtoms, now);
      return savePlan(deps, {
        cardId,
        req,
        transactions,
        authorizationList,
        context: est.context,
        amountAtoms,
        feeAtoms,
        now,
        chainId,
        risk: est.risk ?? null,
      });
    }

    // Budget re-validate + reservation insert as ONE synchronous pair (no await between):
    // the Stripe webhook's fiat leg writes into the SAME budget rows with its own
    // atomic-sync decide+insert and CANNOT take the spend mutex (its 2s reply window
    // can't queue behind a 90s crypto confirmation). A fiat charge that landed during
    // the estimate await gap is therefore always visible here, before we reserve+send.
    if (!settleRow) validateSpend(deps, chain, req, amountAtoms + feeAtoms, now);

    // record BEFORE send so a crash can't double-spend on retry. Settle mode reuses
    // the existing row: only the fee joins the row's budget debit (mirroring what the
    // on-chain enforcers will count).
    const chargeId = settleRow ? settleRow.id : crypto.randomUUID();
    // a reviewed plan executes at most once: claim it atomically before booking the charge
    if (preplanned && !deps.plans!.claimPlan(preplanned.id, now)) {
      throw new EngineError("plan", "plan was already executed or has expired");
    }
    if (settleRow) {
      store.updateCharge(settleRow.id, { fee_atoms: feeAtoms });
    } else {
      store.insertCharge({
        id: chargeId,
        card_id: cardId,
        idempotency_key: req.idempotencyKey ?? null,
        kind: req.kind,
        to_addr: req.to ?? null,
        amount_atoms: amountAtoms,
        fee_atoms: feeAtoms,
        request_id: null,
        tx_hash: null,
        status: "pending",
        memo: req.memo ?? null,
        created_at: now,
      });
    }

    const viaChain = deps.confirmViaChain ?? !executorVerifiesReceipts(deps.relayer);
    // block height BEFORE send: the log-scan window for chain-side confirmation
    const sinceBlock = viaChain ? await publicClient(chainId).getBlockNumber() : 0n;

    // TOCTOU guard: a freeze/revoke can land during the async estimate round-trips.
    // Re-read the chain's status from the store (no RPC) and bail BEFORE broadcasting
    // rather than emitting a spend we already had grounds to refuse. The chain remains
    // the ultimate backstop for anything that still slips through.
    try {
      assertChainSpendable(store.ancestorChain(cardId), now);
    } catch (e) {
      // settle mode: the authorization was already approved, so the row keeps holding
      // its budget; leave it 'pending' (retryable) instead of releasing it as failed
      if (!settleRow) store.updateCharge(chargeId, { status: "failed" });
      throw e;
    }

    if (settleRow) {
      // claim BEFORE broadcast: if the process dies mid-send (or send errors
      // ambiguously: a timeout may still have queued the tx), the row keeps a
      // non-null request_id, so the fiat sweep can never re-drive and
      // double-broadcast it. The reconcile sweep resolves it from chain truth
      // via the fee-leg log (fee fingerprint + the since_block recorded here).
      store.updateCharge(chargeId, { request_id: `claim-${chargeId}`, since_block: sinceBlock });
    }

    if (preplanned) deps.plans!.setPlanStatus(preplanned.id, "executed", chargeId);
    const digest = encodeRedemption(transactions).digest;
    deps.plans?.linkDigest(digest, { charge_id: chargeId, card_id: cardId });
    const purpose: ExecutionPurpose = req.purpose ?? (settleRow ? "settle" : "pay");

    let requestId: string;
    try {
      requestId = await trace
        .getTracer("attestpay-engine")
        .startActiveSpan(deps.relayer.kind === "keeperhub" ? "keeperhub_redeem" : "1shot_relayer_redeem", async (span) => {
          span.setAttribute("chain_id", chainId);
          span.setAttribute("card_id", cardId);
          span.setAttribute("usdc_amount", atomsToUsdc(amountAtoms));
          span.setAttribute("smart_account_address", user.address);
          span.setAttribute("executor", deps.relayer.kind ?? "1shot");
          span.setAttribute("plan_digest", digest);
          try {
            const result = await deps.relayer.send(transactions, est.context!, authorizationList, {
              purpose,
              cardId,
              chargeId,
            });
            span.end();
            return result;
          } catch (e) {
            span.recordException(e as Error);
            span.setStatus({ code: 2, message: e instanceof Error ? e.message : String(e) });
            span.end();
            throw e;
          }
        });
    } catch (e) {
      // pre-broadcast failure: settle rows stay 'pending' (the claim above parks
      // them with reconcile rather than re-driving an ambiguous send)
      if (!settleRow) store.updateCharge(chargeId, { status: "failed" });
      if (preplanned) deps.plans!.setPlanStatus(preplanned.id, "failed", chargeId);
      throw e;
    }
    // record request_id + the broadcast block: reconcile scans the fee-leg log from
    // since_block (never head-lookback), so a landed log is found no matter how long
    // the sweep was down.
    store.updateCharge(chargeId, { request_id: requestId, since_block: sinceBlock });

    const confirmation = viaChain
      ? await confirmRedemption(deps.relayer, {
          requestId,
          delegator: user.address as Address,
          feeAtoms,
          sinceBlock,
          chainId,
          feeCollector: feeData?.feeCollector,
        })
      : statusToConfirmation(await deps.relayer.waitForStatus(requestId));

    if (confirmation.status === "confirmed") {
      store.updateCharge(chargeId, { status: "confirmed", tx_hash: confirmation.txHash ?? undefined });
      usdcSpentTotal.add(Number(atomsToUsdc(amountAtoms)));
      chargesTotal.add(1);
      emitChargeLog("confirmed", cardId, atomsToUsdc(amountAtoms), req.kind);
      notifyConfirmed(deps, chargeId, cardId);
      return receiptFromCharge(deps, cardId, "confirmed", confirmation.txHash, req.to ?? FEE_COLLECTOR, amountAtoms, feeAtoms, now, req.memo);
    }
    if (confirmation.status === "failed") {
      if (settleRow) {
        // an approved fiat charge never releases its budget: flag for ops instead
        store.updateCharge(chargeId, { status: "settlement_unconfirmed", tx_hash: confirmation.txHash ?? undefined });
        throw new EngineError("send", "settlement transaction reverted on-chain");
      }
      store.updateCharge(chargeId, { status: "failed", tx_hash: confirmation.txHash ?? undefined });
      throw new EngineError("send", "transaction reverted on-chain");
    }
    // genuinely still pending: leave the row; reconciliation can settle it later
    return receiptFromCharge(deps, cardId, "pending", confirmation.txHash, req.to ?? FEE_COLLECTOR, amountAtoms, feeAtoms, now, req.memo);
  }

  throw new EngineError("estimate", `estimate loop exhausted: ${lastError ?? "fee kept increasing"}`);
}

function savePlan(
  deps: SpendDeps,
  p: {
    cardId: string;
    req: SpendRequest;
    transactions: RelayerTransaction[];
    authorizationList: Wire7702Auth[] | undefined;
    context: string;
    amountAtoms: bigint;
    feeAtoms: bigint;
    now: number;
    chainId: ChainId;
    risk?: RiskAssessment | null;
  },
): SpendPlan {
  if (!deps.plans) throw new EngineError("plan", "reviewed plans are not available on this executor");
  const encoded = encodeRedemption(p.transactions);
  const ctx = parsePlanContext(p.context);
  const planId = `plan_${crypto.randomUUID()}`;
  const expiresAt = p.now + (deps.planTtlSeconds ?? 600);
  const redeemer = p.transactions[0]!.permissionContext[0]!.delegate;
  const simulation = {
    engine: deps.relayer.kind ?? "1shot",
    would_revert: false as const,
    gas_estimate: ctx?.gasEstimate ?? null,
    simulated_at: ctx?.simulatedAt ?? null,
    redeemer,
    execution_count: encoded.executionCount,
  };
  deps.plans.insertPlan({
    id: planId,
    card_id: p.cardId,
    digest: encoded.digest,
    kind: p.req.kind,
    mode: p.req.mode,
    to_addr: p.req.to ?? null,
    amount_atoms: p.amountAtoms,
    fee_atoms: p.feeAtoms,
    memo: p.req.memo ?? null,
    idempotency_key: p.req.idempotencyKey ?? null,
    transactions: p.transactions,
    authorization_list: p.authorizationList ?? null,
    context: p.context,
    simulation,
    created_at: p.now,
    expires_at: expiresAt,
  });
  deps.plans.linkDigest(encoded.digest, { card_id: p.cardId });

  // what the period meter will read if this plan executes now
  const state = cardState(deps.store, p.cardId, p.now);
  const remaining = state?.remaining_this_period;
  const after =
    remaining === null || remaining === undefined
      ? null
      : atomsToUsdc(usdcToAtoms(remaining) - p.amountAtoms - p.feeAtoms);

  return {
    status: "planned",
    plan_id: planId,
    card_id: p.cardId,
    digest: encoded.digest,
    executor: deps.relayer.kind ?? "1shot",
    workflow: p.req.purpose ?? "pay",
    to: p.req.to ?? null,
    amount: atomsToUsdc(p.amountAtoms),
    fee: atomsToUsdc(p.feeAtoms),
    total: atomsToUsdc(p.amountAtoms + p.feeAtoms),
    ...(p.req.memo ? { memo: p.req.memo } : {}),
    simulation,
    remaining_this_period_after: after,
    expires_at: expiresAt,
    ...(p.risk ? { risk: p.risk } : {}),
  };
}

export function statusToConfirmation(st: { status: number | null; txHash: Hex | null }): {
  status: "confirmed" | "failed" | "pending";
  txHash: Hex | null;
} {
  if (st.status === 200) return { status: "confirmed", txHash: st.txHash };
  if (st.status === 500) return { status: "failed", txHash: st.txHash };
  return { status: "pending", txHash: st.txHash };
}

function receiptFromCharge(
  deps: SpendDeps,
  cardId: string,
  status: Receipt["status"] | "failed",
  tx: Hex | null,
  to: Address,
  amountAtoms: bigint,
  feeAtoms: bigint,
  now: number,
  memo?: string,
): Receipt {
  const state = cardState(deps.store, cardId, now);
  return {
    status: status as Receipt["status"],
    tx,
    to,
    amount: atomsToUsdc(amountAtoms),
    fee: atomsToUsdc(feeAtoms),
    remaining_this_period: state?.remaining_this_period ?? null,
    ...(memo ? { memo } : {}),
  };
}

// ---------------------------------------------------------------------------
// Reconcile sweep: settle charges left "pending" (confirmRedemption timed out but
// the tx may have landed). A pending charge counts against budget forever until
// resolved, so this re-checks each broadcast-but-unconfirmed charge against chain
// logs and flips it to confirmed/failed. Safe to call periodically (idempotent).
// ---------------------------------------------------------------------------

export async function reconcilePending(
  deps: SpendDeps,
  opts: {
    olderThanSeconds?: number;
    lookbackBlocks?: bigint;
    /** test seam: fee-leg Transfer log scan (delegator -> feeCollector since fromBlock) */
    scanFeeLogs?: (delegator: Address, fromBlock: bigint) => Promise<Array<{ value: bigint; txHash: Hex }>>;
    /** test seam: chain head */
    blockNumber?: () => Promise<bigint>;
  } = {},
): Promise<{ reconciled: number; stillPending: number }> {
  const chainId = deps.chainId ?? CHAIN_ID;
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  // cutoff defaults to 10 min (>> confirmRedemption's 90s timeout): a tx unmined this
  // long on Base (2s blocks) is genuinely dropped, so failing it can't race a late mine.
  const cutoff = now - (opts.olderThanSeconds ?? 600);
  // KeeperHub-executed rows are never resolved from fee logs: KeeperHub owns their
  // nonce/gas/retry lifecycle and its verified status is the answer (reconcileKeeperHub)
  const stale = deps.store.pendingChargesOlderThan(cutoff).filter((c) => !parseKeeperHubRequestId(c.request_id));
  // x402 reservations that never reached a relayer broadcast (request_id null) leak
  // budget if the inline finalize was lost; free them after a generous TTL.
  const x402Cutoff = now - (opts.olderThanSeconds ?? 600) * 6; // ~1h default
  const x402Orphans = deps.store.pendingX402ChargesOlderThan(x402Cutoff);
  if (!stale.length && !x402Orphans.length) return { reconciled: 0, stillPending: 0 };

  let reconciled = 0;
  for (const orphan of x402Orphans) {
    deps.store.updateCharge(orphan.id, { status: "failed" });
    reconciled++;
  }
  if (!stale.length) return { reconciled, stillPending: 0 };

  const pub = publicClient(chainId);
  const usdc = CHAINS[chainId].usdc;
  const scan =
    opts.scanFeeLogs ??
    (async (delegator: Address, fromBlock: bigint) => {
      const logs = await pub.getLogs({
        address: usdc,
        event: {
          type: "event",
          name: "Transfer",
          inputs: [
            { name: "from", type: "address", indexed: true },
            { name: "to", type: "address", indexed: true },
            { name: "value", type: "uint256", indexed: false },
          ],
        },
        args: { from: delegator, to: FEE_COLLECTOR },
        fromBlock,
      });
      return logs.map((l) => ({ value: (l.args as { value?: bigint }).value ?? 0n, txHash: l.transactionHash }));
    });

  let head: bigint;
  try {
    head = await (opts.blockNumber ?? (() => pub.getBlockNumber()))();
  } catch {
    return { reconciled, stillPending: stale.length }; // RPC down: next sweep
  }
  const fallbackFrom = head > (opts.lookbackBlocks ?? 5000n) ? head - (opts.lookbackBlocks ?? 5000n) : 0n;

  // Group stale charges by ancestor user so we scan each user's fee-leg logs ONCE, from
  // the earliest broadcast block among that user's charges (every charge's fee-leg lives
  // in [its since_block, head]). A per-user consumed-txHash set stops two same-fee charges
  // (the 0..999 jitter only probabilistically unique) from both claiming one log.
  const byUser = new Map<string, { address: Address; charges: typeof stale; minFrom: bigint }>();
  let stillPending = 0;
  for (const charge of stale) {
    const user = deps.store.getUser(deps.store.ancestorChain(charge.card_id).at(-1)?.user_id ?? "");
    if (!user) {
      stillPending++; // orphaned row (card/user gone): can't resolve a delegator — surface it
      continue;
    }
    const from = charge.since_block ? BigInt(charge.since_block) : fallbackFrom;
    const g = byUser.get(user.id) ?? { address: user.address as Address, charges: [] as typeof stale, minFrom: from };
    g.charges.push(charge);
    if (from < g.minFrom) g.minFrom = from;
    byUser.set(user.id, g);
  }

  for (const { address, charges, minFrom } of byUser.values()) {
    let logs: Array<{ value: bigint; txHash: Hex }>;
    try {
      logs = await scan(address, minFrom);
    } catch {
      stillPending += charges.length; // RPC blip: leave them for the next sweep
      continue;
    }
    const consumed = new Set<Hex>();
    for (const charge of charges) {
      // the fee jitter makes (delegator, feeCollector, value) a per-spend fingerprint;
      // skip logs already claimed by an earlier charge this sweep
      const hit = logs.find((l) => l.value === charge.fee_atoms && !consumed.has(l.txHash));
      if (hit) {
        consumed.add(hit.txHash);
        deps.store.updateCharge(charge.id, { status: "confirmed", tx_hash: hit.txHash });
        notifyConfirmed(deps, charge.id, charge.card_id);
      } else if (charge.kind === "fiat") {
        // no fee-leg log, but a fiat charge was already approved to the card network:
        // budget stays held and the row is flagged for ops instead of released.
        deps.store.updateCharge(charge.id, { status: "settlement_unconfirmed" });
      } else {
        // no unclaimed fee-leg log since the broadcast block: the redemption never landed.
        deps.store.updateCharge(charge.id, { status: "failed" });
      }
      reconciled++;
    }
  }
  return { reconciled, stillPending };
}

// ---------------------------------------------------------------------------
// stuck-charge-recovery: charges KeeperHub executed but whose inline confirmation
// timed out. KeeperHub already handles what makes a transaction stuck (nonce
// management, gas re-pricing, retries with backoff), so recovery is a question, not a
// re-send: ask KeeperHub for the verified outcome and settle the ledger from it.
// `unconfirmed` / running stays pending; it is never re-broadcast from here.
// ---------------------------------------------------------------------------

export type KeeperHubRecoveryResult = {
  examined: number;
  confirmed: number;
  failed: number;
  still_pending: number;
  charges: Array<{ charge_id: string; card_id: string; status: string; tx: Hex | null; execution: string }>;
};

export async function reconcileKeeperHub(
  deps: SpendDeps,
  opts: { olderThanSeconds?: number; limit?: number; /** only these charges (a hook nudge) */ chargeIds?: string[] } = {},
): Promise<KeeperHubRecoveryResult> {
  const now = deps.now ? deps.now() : Math.floor(Date.now() / 1000);
  // store filter is strict (created_at < cutoff): a nudge must also see a charge booked this second
  const cutoff = opts.chargeIds ? now + 1 : now - (opts.olderThanSeconds ?? 60);
  const only = opts.chargeIds ? new Set(opts.chargeIds) : null;
  const rows = deps.store
    .pendingChargesOlderThan(cutoff)
    .filter((c) => parseKeeperHubRequestId(c.request_id) && (!only || only.has(c.id)))
    .slice(0, opts.limit ?? 100);
  const out: KeeperHubRecoveryResult = { examined: rows.length, confirmed: 0, failed: 0, still_pending: 0, charges: [] };

  for (const charge of rows) {
    const execution = charge.request_id!;
    const st = await deps.relayer.getStatus(execution);
    if (st.status === 200) {
      deps.store.updateCharge(charge.id, { status: "confirmed", tx_hash: st.txHash ?? undefined });
      usdcSpentTotal.add(Number(atomsToUsdc(charge.amount_atoms)));
      chargesTotal.add(1);
      emitChargeLog("confirmed", charge.card_id, atomsToUsdc(charge.amount_atoms), charge.kind);
      notifyConfirmed(deps, charge.id, charge.card_id);
      out.confirmed++;
      out.charges.push({ charge_id: charge.id, card_id: charge.card_id, status: "confirmed", tx: st.txHash, execution });
    } else if (st.status === 500) {
      // an approved Visa charge never releases its budget: flag it for ops instead
      const status = charge.kind === "fiat" ? "settlement_unconfirmed" : "failed";
      deps.store.updateCharge(charge.id, { status, tx_hash: st.txHash ?? undefined });
      out.failed++;
      out.charges.push({ charge_id: charge.id, card_id: charge.card_id, status, tx: st.txHash, execution });
    } else {
      out.still_pending++;
      out.charges.push({ charge_id: charge.id, card_id: charge.card_id, status: "pending", tx: st.txHash, execution });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live card state (the `card` tool / dashboard meters)
// ---------------------------------------------------------------------------

export function cardState(store: Store, cardId: string, now: number): CardState | null {
  const card = store.getCard(cardId);
  if (!card) return null;
  const pay = card.terms.pay;

  let remainingPeriod: string | null = null;
  let resetsAt: number | null = null;
  if (pay?.period && card.compiled.periodStartDate !== null) {
    const w = periodWindow(card.compiled.periodStartDate, pay.period.seconds, now);
    const spent = store.subtreeSpentSince(cardId, w.start);
    const cap = usdcToAtoms(pay.period.amount);
    remainingPeriod = atomsToUsdc(cap > spent ? cap - spent : 0n);
    resetsAt = w.resetsAt;
  }

  let remainingLifetime: string | null = null;
  if (pay?.lifetime) {
    const spent = store.subtreeSpentLifetime(cardId);
    const cap = usdcToAtoms(pay.lifetime.amount);
    remainingLifetime = atomsToUsdc(cap > spent ? cap - spent : 0n);
  }

  const expired = card.terms.expiry !== undefined && now >= card.terms.expiry;

  return {
    card_id: card.id,
    name: card.name,
    status: card.status === "active" && expired ? "expired" : (card.status as CardState["status"]),
    terms: card.terms,
    remaining_this_period: remainingPeriod,
    remaining_lifetime: remainingLifetime,
    period_resets_at: resetsAt,
    expires_at: card.terms.expiry ?? null,
    uses_remaining: card.terms.maxUses !== undefined ? Math.max(0, card.terms.maxUses - store.subtreeUsesCount(cardId)) : null,
    subcards: store.listChildren(cardId).map((c) => c.id),
  };
}
