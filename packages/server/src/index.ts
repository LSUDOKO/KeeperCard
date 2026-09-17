// KeeperCard server: the one always-on process.
// Hostname routing on a single Hono app:
//   mcp.*          -> MCP endpoint (/c/<secret>/mcp) + dashboard API + webhooks
//   facilitator.*  -> erc7710 x402 facilitator (verify/settle/supported) + demo seller
// Facilitator routes use fetch + WebCrypto ONLY (portability rule: 20-min Workers escape hatch).
//
// Recurring work: with KeeperHub configured, KeeperHub's scheduler drives it
// (stuck-charge-recovery, fiat-settlement-sweep -> /api/keeperhub/hooks/*) and the
// in-process timers below stay off, loudly. Without it, the legacy timers run.

import { trace } from "@opentelemetry/api";
import { keeperhub } from "@attestpay/engine";
import { createApp } from "./app";
import { envInt, realDeps } from "./deps";
import { deliverWebhooks } from "./events/deliver";
import { keeperhubDrivesSweeps, runFiatSettlement, runReceiptSweep, runRecovery } from "./keeperhub/sweeps";

const deps = realDeps();

// Workflow ids are looked up by NAME, so a deployment needs no KEEPERHUB_WORKFLOW_* env
// vars: provision once and the server finds them. Awaited before the listener starts,
// so the first payment already routes through its workflow. A KeeperHub that cannot be
// reached leaves the config as it was and payments fall back to direct execution.
if (deps.keeperhub?.config && deps.keeperhub.client) {
  const r = await keeperhub.resolveWorkflowIds(deps.keeperhub.client, deps.keeperhub.config);
  if (r.error) console.warn(`[keeperhub] could not look up workflows by name (${r.error}); using configured ids only`);
  const wf = deps.keeperhub.config.workflows;
  const live = keeperhub.KEEPERHUB_WORKFLOW_KEYS.filter((k) => wf[k]);
  console.log(
    `[keeperhub] ${live.length}/${keeperhub.KEEPERHUB_WORKFLOW_KEYS.length} workflows live (${r.resolved.length} resolved by name): ${live.join(" ") || "none — run keeperhub:provision"}`,
  );
}

const app = createApp(deps);
const port = envInt("PORT", 4070);
const otel = trace.getTracer("keepercard-server");

const khDriven = keeperhubDrivesSweeps(deps);

if (khDriven) {
  const wf = deps.keeperhub!.config!.workflows;
  console.log(
    `[keeperhub] recurring work is scheduled by KeeperHub · stuck-charge-recovery=${wf.recovery} fiat-settlement-sweep=${wf.sweep ?? "-"}`,
  );
  for (const name of keeperhub.DEPRECATED_INTERVAL_VARS) {
    if (process.env[name] !== undefined) {
      console.warn(`[keeperhub] ${name} is DEPRECATED and ignored: this timer is a KeeperHub scheduled workflow now`);
    }
  }
} else {
  // ---- legacy lane: in-process timers ----

  // Reconcile sweep: charges left "pending" (confirm timed out) hold budget until settled.
  const reconcileMs = envInt("ATTESTPAY_RECONCILE_INTERVAL_MS", 300_000);
  if (reconcileMs > 0) {
    setInterval(() => void runRecovery(deps).catch(() => {}), reconcileMs);
  } else {
    console.log("[reconcile] sweep DISABLED (ATTESTPAY_RECONCILE_INTERVAL_MS=0): stuck pending charges will hold budget");
  }

  // Fiat settlement sweep: approved Visa rows the inline kickoff missed.
  if (deps.fiatSettler) {
    const settleMs = envInt("ATTESTPAY_FIAT_SETTLE_INTERVAL_MS", 60_000);
    if (settleMs > 0) setInterval(() => void runFiatSettlement(deps).catch(() => {}), settleMs);
    setTimeout(() => void runFiatSettlement(deps).catch(() => {}), 5_000); // startup crash recovery
  }

  if (deps.keeperhub?.config) {
    // Not a misconfiguration on the free plan: recovery and the settlement sweep are
    // schedule-plus-callback workflows, and HTTP Request is a Pro action. KeeperHub still
    // executes every payment; only the reconcile heartbeat stays in this process.
    console.log("[keeperhub] reconcile + settlement timers run in-process (the callback workflows need KeeperHub Pro)");
  }
}

// Receipts that were queued but never landed (a restart, an empty gas tank, a busy
// KeeperHub). The charge-confirmed hook anchors eagerly; this catches the rest.
if (deps.keeperhub?.receipts) {
  const receiptMs = envInt("KEEPERHUB_RECEIPT_SWEEP_INTERVAL_MS", 120_000);
  if (receiptMs > 0) {
    setInterval(() => void runReceiptSweep(deps).catch(() => {}), receiptMs);
    setTimeout(() => void runReceiptSweep(deps).catch(() => {}), 15_000);
  }
}

// Webhook delivery sweep: payment-critical signed webhooks stay on KeeperCard's own
// HMAC queue by design (non-critical notifications relay through KeeperHub).
if (deps.events) {
  const bus = deps.events;
  const whMs = envInt("ATTESTPAY_WEBHOOK_INTERVAL_MS", 15_000);
  if (whMs > 0) {
    setInterval(() => {
      otel.startActiveSpan("webhook_deliver_sweep", async (span) => {
        try {
          const r = await deliverWebhooks(bus.events);
          span.setAttribute("attempted", r.attempted);
          span.setAttribute("delivered", r.delivered);
          span.setAttribute("dead", r.dead);
          if (r.attempted) console.log(`[webhooks] ${r.delivered} delivered, ${r.failed} retrying, ${r.dead} dead`);
        } catch (e) {
          span.recordException(e as Error);
        } finally {
          span.end();
        }
      });
    }, whMs);
  }
}

console.log(`keepercard server listening on :${port} · executor=${deps.relayer.kind}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
