// The background work KeeperCard used to drive with in-process setInterval timers,
// as plain callable units. With KeeperHub configured, KeeperHub's scheduler is the
// heartbeat: the stuck-charge-recovery and fiat-settlement-sweep workflows call these
// through /api/keeperhub/hooks/*. Without it (legacy lane), index.ts still runs them
// on timers. Either way the logic lives in exactly one place.

import { trace } from "@opentelemetry/api";
import { CHAIN_ID, CHAINS, reconcileKeeperHub, reconcilePending, type KeeperHubRecoveryResult } from "@attestpay/engine";
import { spendDeps, type AppDeps } from "../deps";

const otel = trace.getTracer("keepercard-server");

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
  receipts: ReceiptSweepSummary | null;
};

/** stuck-charge-recovery: KeeperHub-executed charges settle from KeeperHub's verified
 * status; any legacy 1Shot rows still in the books settle from chain logs. */
export async function runRecovery(deps: AppDeps, opts: { chargeIds?: string[]; includeReceipts?: boolean } = {}): Promise<RecoverySummary> {
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
    const receipts = opts.includeReceipts ? await runReceiptSweep(deps) : null;
    return { keeperhub: kh, legacy, still_pending: kh.still_pending + legacy.stillPending, receipts };
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

export type ReceiptSweepSummary = { examined: number; anchored: number; pending: number };

/** payment-receipt-anchor: retry receipts that were queued but have not landed. The
 * charge-confirmed hook anchors eagerly; this is what catches the ones a restart,
 * an empty gas tank or a busy KeeperHub left behind. */
export async function runReceiptSweep(deps: AppDeps): Promise<ReceiptSweepSummary | null> {
  const receipts = deps.keeperhub?.receipts;
  if (!receipts) return null;
  return span("keeperhub.receipt_sweep", async (set) => {
    const cardIds = deps.store.listAllCardIds();
    const r = await receipts.sweep(cardIds, 10);
    set("examined", r.examined);
    set("anchored", r.anchored);
    set("pending", r.pending);
    if (r.anchored) console.log(`[receipts] sweep anchored ${r.anchored} payment(s) (${r.pending} still pending)`);
    return r;
  });
}

/** True when KeeperHub's scheduler owns the recurring work for this deployment. */
export function keeperhubDrivesSweeps(deps: AppDeps): boolean {
  const cfg = deps.keeperhub?.config;
  return !!(cfg && cfg.hookSecret && cfg.workflows.recovery);
}
