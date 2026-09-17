// /api/keeperhub/hooks/*: the endpoints KeeperHub workflows call back into.
//
// Authenticated by a shared secret header (KEEPERHUB_HOOK_SECRET, baked into the
// provisioned workflows), and deliberately low-trust even then: a hook is a NUDGE.
// Nothing in a hook body is written to the ledger. Each handler re-reads the
// execution from KeeperHub's own API (or the chain) and settles from that, so a
// forged or replayed callback can at most make KeeperCard look something up early.

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { keeperhub } from "@attestpay/engine";
import type { AppDeps } from "../deps";
import { runFiatSettlement, runReceiptSweep, runRecovery } from "./sweeps";

const equal = (a: string, b: string): boolean =>
  timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

type HookBody = {
  workflow?: string;
  digest?: string;
  chargeId?: string;
  cardId?: string;
  transactionHash?: string;
};

export function keeperhubHookRoutes(deps: AppDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const secret = deps.keeperhub?.config?.hookSecret;
    if (!secret) return c.json({ error: "keeperhub hooks are not configured on this deployment" }, 503);
    const given = c.req.header(keeperhub.HOOK_SECRET_HEADER) ?? "";
    if (!given || !equal(given, secret)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  const body = async (c: { req: { json: () => Promise<unknown> } }): Promise<HookBody> => {
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" && v.length <= 200 && !v.includes("{{") ? v : undefined);
    return { workflow: s(b.workflow), digest: s(b.digest), chargeId: s(b.chargeId), cardId: s(b.cardId), transactionHash: s(b.transactionHash) };
  };

  const audit = (action: string, detail: Record<string, unknown>) =>
    deps.events?.audit({ kind: "system", id: "keeperhub" }, `keeperhub.hook.${action}`, { type: "keeperhub", id: action }, detail);

  // card-payment-redemption / credit-line-draw-repay finished a run
  app.post("/execution", async (c) => {
    const b = await body(c);
    return keeperhub.traceKeeperHub("hook", { "keeperhub.hook": "execution", ...(b.chargeId ? { charge_id: b.chargeId } : {}) }, async () => {
      const r = await runRecovery(deps, b.chargeId ? { chargeIds: [b.chargeId] } : {});
      audit("execution", { workflow: b.workflow ?? null, charge_id: b.chargeId ?? null, confirmed: r.keeperhub.confirmed, failed: r.keeperhub.failed });
      return c.json({ ok: true, ...summary(r) });
    });
  });

  // stuck-charge-recovery schedule tick (also advances the cross-chain proof pipeline)
  app.post("/recovery", async (c) =>
    keeperhub.traceKeeperHub("hook", { "keeperhub.hook": "recovery" }, async () => {
      const r = await runRecovery(deps, { includeReceipts: true });
      audit("recovery", summary(r));
      return c.json({ ok: true, ...summary(r) });
    }),
  );

  // fiat-settlement-sweep schedule tick
  app.post("/settle", async (c) =>
    keeperhub.traceKeeperHub("hook", { "keeperhub.hook": "settle" }, async () => {
      const r = await runFiatSettlement(deps);
      audit("settle", r);
      return c.json({ ok: true, ...r });
    }),
  );

  // payment-receipt-anchor wrote a receipt: settle any others still waiting
  app.post("/anchored", async (c) => {
    const b = await body(c);
    return keeperhub.traceKeeperHub("hook", { "keeperhub.hook": "anchored", ...(b.chargeId ? { charge_id: b.chargeId } : {}) }, async () => {
      const r = await runReceiptSweep(deps);
      audit("anchored", { charge_id: b.chargeId ?? null, receipts: r });
      return c.json({ ok: true, receipts: r });
    });
  });

  return app;
}

function summary(r: Awaited<ReturnType<typeof runRecovery>>) {
  return {
    examined: r.keeperhub.examined,
    confirmed: r.keeperhub.confirmed,
    failed: r.keeperhub.failed,
    still_pending: r.still_pending,
    legacy_reconciled: r.legacy.reconciled,
    receipts: r.receipts,
  };
}
