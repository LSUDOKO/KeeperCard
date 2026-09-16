// The background work AttestPay used to drive with in-process setInterval timers,
// as plain callable units. With KeeperHub configured, KeeperHub's scheduler is the
// heartbeat: the stuck-charge-recovery and fiat-settlement-sweep workflows call these
// through /api/keeperhub/hooks/*. Without it (legacy lane), index.ts still runs them
// on timers. Either way the logic lives in exactly one place.

import { trace } from "@opentelemetry/api";
import { CHAIN_ID, CHAINS, attestcoin, reconcileKeeperHub, reconcilePending, type KeeperHubRecoveryResult } from "@attestpay/engine";
import { spendDeps, type AppDeps } from "../deps";

const otel = trace.getTracer("attestpay-server");

async function span<T>(name: string, fn: (set: (k: string, v: string | number | boolean) => void) => Promise<T>): Promise<T> {
  return otel.startActiveSpan(name, async (s) => {
    try {
      return await fn((k, v) => s.setAttribute(k, v));
    } catch (e) {
      s.recordException(e as Error);
      s.setStatus({ code: 2, message: e instanceof Error ? e.message : String(e) });
      throw e;
    } finally {
      s.end();
    }
  });
}

export type RecoverySummary = {
  keeperhub: KeeperHubRecoveryResult;
  legacy: { reconciled: number; stillPending: number };
  still_pending: number;
  attestcoin: AttestcoinSweepSummary | null;
};

/** stuck-charge-recovery: KeeperHub-executed charges settle from KeeperHub's verified
 * status; any legacy 1Shot rows still in the books settle from chain logs. */
export async function runRecovery(deps: AppDeps, opts: { chargeIds?: string[]; includeAttestcoin?: boolean } = {}): Promise<RecoverySummary> {
  return span("keeperhub.stuck_charge_recovery", async (set) => {
    const sd = spendDeps(deps);
    const kh = await reconcileKeeperHub(sd, opts.chargeIds ? { chargeIds: opts.chargeIds } : {});
    let legacy = { reconciled: 0, stillPending: 0 };
    if (!opts.chargeIds && deps.relayer.kind === "1shot") {
      legacy = await reconcilePending({ store: deps.store, relayer: deps.relayer });
    }
    set("keeperhub.examined", kh.examined);
    set("keeperhub.confirmed", kh.confirmed);
    set("keeperhub.failed", kh.failed);
    set("keeperhub.still_pending", kh.still_pending);
    set("legacy.reconciled", legacy.reconciled);
    if (kh.confirmed || kh.failed || legacy.reconciled) {
      console.log(
        `[recovery] keeperhub: ${kh.confirmed} confirmed, ${kh.failed} failed, ${kh.still_pending} pending · legacy: ${legacy.reconciled} reconciled`,
      );
    }
    const ac = opts.includeAttestcoin ? await runAttestcoinSweep(deps) : null;
    return { keeperhub: kh, legacy, still_pending: kh.still_pending + legacy.stillPending, attestcoin: ac };
  });
}

/**
 * Does the account the settlement pays from still hold enough USDC to be worth a sweep?
 *
 * Read through KeeperHub's `check-and-execute`, whose point is that the read and the
 * conditional write happen in one request — so the balance cannot move between deciding
 * and acting the way it can when a caller reads, decides, then sends separately. Here
 * the action leg is deliberately a no-op self-transfer of 0: the sweep itself does the
 * paying, and all this needs is the guarded read.
 *
 * Returns null when the guard could not be evaluated. Null means "unknown", and the
 * caller sweeps anyway — a balance oracle being unavailable must not stop settlement.
 */
async function settlementFundsAvailable(deps: AppDeps, minAtoms: bigint): Promise<{ ok: boolean; observed: string | null } | null> {
  const kh = deps.keeperhub;
  if (!kh?.client || !kh.config) return null;
  try {
    const wallet = await deps.relayer.delegateAddress();
    const usdc = CHAINS[CHAIN_ID].usdc;
    const r = await kh.client.checkAndExecute({
      chainId: CHAIN_ID,
      check: {
        contractAddress: usdc,
        functionName: "balanceOf",
        functionArgs: JSON.stringify([wallet]),
        abi: JSON.stringify(ERC20_BALANCE_ABI),
      },
      condition: { operator: "gte", value: minAtoms.toString() },
      action: {
        contractAddress: usdc,
        functionName: "transfer",
        functionArgs: JSON.stringify([wallet, "0"]),
        abi: JSON.stringify(ERC20_TRANSFER_ABI),
      },
    });
    return { ok: r.condition.met, observed: r.condition.observedValue };
  } catch {
    return null;
  }
}

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const ERC20_TRANSFER_ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** fiat-settlement-sweep: approved Visa rows re-driven through spend(). */
export async function runFiatSettlement(deps: AppDeps): Promise<{ enabled: boolean; settled: number; left: number; skipped?: string }> {
  if (!deps.fiatSettler) return { enabled: false, settled: 0, left: 0 };
  const settler = deps.fiatSettler;
  return span("fiat_settle_sweep", async (set) => {
    // A sweep with nothing to pay from burns gas on redemptions that can only revert.
    const min = BigInt(process.env.ATTESTPAY_SETTLE_MIN_USDC_ATOMS ?? "0");
    if (min > 0n) {
      const guard = await settlementFundsAvailable(deps, min);
      if (guard) {
        set("guard_observed", guard.observed ?? "unknown");
        if (!guard.ok) {
          const msg = `settlement account holds ${guard.observed ?? "?"} USDC atoms, below the ${min} floor`;
          set("skipped", msg);
          console.log(`[settle] sweep skipped: ${msg}`);
          return { enabled: true, settled: 0, left: 0, skipped: msg };
        }
      }
    }
    const r = await settler.sweep();
    set("settled", r.settled);
    set("left", r.left);
    if (r.settled) console.log(`[settle] sweep settled ${r.settled} fiat charge(s) (${r.left} left)`);
    return { enabled: true, ...r };
  });
}

export type AttestcoinSweepSummary = {
  ready: boolean;
  proofs?: attestcoin.SweepResult;
  facts?: attestcoin.SweepResult;
  lines?: { opened: number; defaulted: number; closed: number };
};

let bootPromise: Promise<boolean> | null = null;

/** One-time Attestcoin boot: chain key resolution + deployment check. Memoized. */
export function bootAttestcoin(deps: AppDeps): Promise<boolean> {
  if (bootPromise) return bootPromise;
  const client = deps.attestcoin?.client;
  if (!client) return (bootPromise = Promise.resolve(false));
  bootPromise = (async () => {
    // With KeeperHub anchoring, the ASC must trust KeeperHub's wallet, not this key.
    if (deps.keeperhub?.anchorer) {
      try {
        const wallet = await deps.relayer.delegateAddress();
        client.usePaymentAnchorer(wallet);
        console.log(`[attestcoin] payment anchorer = KeeperHub wallet ${wallet}`);
      } catch (e) {
        console.error(`[attestcoin] could not resolve the KeeperHub wallet for anchoring: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try {
      const r = await client.resolveChainKey();
      console.log(
        `[attestcoin] chain key ${r.chainKey} (${r.source}) · source chain ${r.sourceChainId} · attested chains: ${
          r.chains.map((c) => `${c.chainKey}=${c.chainId}(${c.name})`).join(", ") || "unknown"
        } · payment chain ${client.config.paymentChainId} attested: ${r.paymentChainAttested}`,
      );
      for (const p of r.problems) console.error(`[attestcoin] CHAIN KEY WARNING: ${p}`);
    } catch (e) {
      console.error(`[attestcoin] chain key resolution failed: ${e instanceof Error ? e.message : String(e)}`);
      if (client.config.chainKeyMode === "auto") {
        console.error("[attestcoin] chain key is 'auto' and could not be resolved: the worker will NOT run");
        return false;
      }
    }
    try {
      const { ok, problems } = await client.checkDeployment();
      if (ok) console.log(`[attestcoin] deployment check OK · anchorer=${client.paymentAnchorerAddress}`);
      else {
        for (const p of problems) console.error(`[attestcoin] DEPLOYMENT MISMATCH: ${p}`);
        console.error("[attestcoin] the worker will keep running, but proofs are likely to be rejected until this is fixed");
      }
    } catch (e) {
      console.error(`[attestcoin] deployment check could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
    const f = attestcoin.attestcoinFeatures(client.config);
    console.log(`[attestcoin] features · credit=${f.credit} disputes=${f.disputes} guarantee=${f.guarantee} passport=${f.passport}`);
    return true;
  })();
  return bootPromise;
}

let sweeping = false;

/** Advances the cross-chain proof pipeline one tick. Never overlaps itself. */
export async function runAttestcoinSweep(deps: AppDeps): Promise<AttestcoinSweepSummary | null> {
  const acDeps = deps.attestcoin;
  if (!acDeps?.client) return null;
  if (sweeping) return { ready: true };
  const client = acDeps.client;
  sweeping = true;
  try {
    return await span("attestcoin_sweep", async (set) => {
      const ready = await bootAttestcoin(deps);
      if (!ready) {
        set("skipped", true);
        return { ready: false };
      }
      const workerDeps: attestcoin.WorkerDeps = {
        store: deps.store,
        attestcoin: acDeps.store,
        client,
        batchSize: Number(process.env.ATTESTPAY_ATTESTCOIN_BATCH_SIZE) || 10,
        anchorer: deps.keeperhub?.anchorer ?? null,
        onTerminal: (e) => {
          if (!deps.events) return;
          if (e.pipeline === "payment") {
            deps.events.emit(e.status === "verified" ? "proof.verified" : "proof.failed", { cardId: e.row.card_id }, {
              charge_id: e.row.charge_id,
              anchor_tx_hash: e.row.anchor_tx_hash,
              creditcoin_tx_hash: e.row.creditcoin_tx_hash,
              error: e.row.error,
            });
          } else {
            deps.events.emit(e.status === "verified" ? "fact.verified" : "fact.failed", { cardId: e.row.card_id }, {
              fact_id: e.row.id,
              kind: e.row.kind,
              ref_id: e.row.ref_id,
              anchor_tx_hash: e.row.anchor_tx_hash,
              creditcoin_tx_hash: e.row.creditcoin_tx_hash,
              error: e.row.error,
            });
          }
        },
      };
      const out: AttestcoinSweepSummary = { ready: true };
      const r = await attestcoin.sweepProofs(workerDeps);
      out.proofs = r;
      set("examined", r.examined);
      set("advanced", r.advanced);
      set("verified", r.verified);
      set("failed", r.failed);
      set("waiting", r.waiting);
      if (r.verified || r.failed) {
        console.log(`[attestcoin] sweep: ${r.verified} verified, ${r.failed} failed, ${r.waiting} waiting (${r.examined} examined)`);
      }
      const features = attestcoin.attestcoinFeatures(client.config);
      if (features.credit || features.disputes) {
        const f = await attestcoin.sweepFacts(workerDeps);
        out.facts = f;
        set("facts_examined", f.examined);
        set("facts_verified", f.verified);
        set("facts_failed", f.failed);
      }
      if (features.credit) {
        const l = await attestcoin.sweepCreditLines({ attestcoin: acDeps.store, client }, Math.floor(Date.now() / 1000));
        out.lines = l;
        set("lines_opened", l.opened);
        set("lines_defaulted", l.defaulted);
      }
      return out;
    });
  } catch (e) {
    console.error(`[attestcoin] sweep threw: ${e instanceof Error ? e.message : String(e)}`);
    return { ready: false };
  } finally {
    sweeping = false;
  }
}

/** True when KeeperHub's scheduler owns the recurring work for this deployment. */
export function keeperhubDrivesSweeps(deps: AppDeps): boolean {
  const cfg = deps.keeperhub?.config;
  return !!(cfg && cfg.hookSecret && cfg.workflows.recovery);
}
