// @attestpay/server: the one always-on process.
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
import {
  bootAttestcoin,
  keeperhubDrivesSweeps,
  runAttestcoinSweep,
  runFiatSettlement,
  runRecovery,
} from "./keeperhub/sweeps";

const deps = realDeps();
const app = createApp(deps);
const port = envInt("PORT", 4070);
const otel = trace.getTracer("attestpay-server");

const khDriven = keeperhubDrivesSweeps(deps);

if (khDriven) {
  const wf = deps.keeperhub!.config!.workflows;
  console.log(
    `[keeperhub] recurring work is scheduled by KeeperHub · stuck-charge-recovery=${wf.recovery} fiat-settlement-sweep=${wf.settle ?? "-"}`,
  );
  for (const name of keeperhub.DEPRECATED_INTERVAL_VARS) {
    if (process.env[name] !== undefined) {
      console.warn(`[keeperhub] ${name} is DEPRECATED and ignored: this timer is a KeeperHub scheduled workflow now`);
    }
  }
  // Attestation waits are minutes long, so KeeperHub's recovery schedule advancing
  // the proof pipeline is enough; boot the chain-key/deployment check eagerly anyway
  // so a misconfiguration is visible at startup rather than at the first tick.
  if (deps.attestcoin?.client) void bootAttestcoin(deps);
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

  // Attestcoin proof worker.
  if (deps.attestcoin?.client) {
    void bootAttestcoin(deps);
    const sweepMs = envInt("ATTESTPAY_ATTESTCOIN_SWEEP_INTERVAL_MS", 60_000);
    if (sweepMs > 0) {
      setInterval(() => void runAttestcoinSweep(deps), sweepMs);
      setTimeout(() => void runAttestcoinSweep(deps), 10_000);
      console.log(`[attestcoin] proof worker every ${sweepMs}ms`);
    } else {
      console.log(
        "[attestcoin] proof worker DISABLED (ATTESTPAY_ATTESTCOIN_SWEEP_INTERVAL_MS=0): payments will queue but never verify",
      );
    }
  }

  if (deps.keeperhub?.config) {
    console.warn(
      "[keeperhub] KeeperHub executes payments, but no stuck-charge-recovery workflow/hook secret is configured: run `bun run keeperhub:provision` so KeeperHub schedules recovery instead of these timers",
    );
  }
}

// Webhook delivery sweep: payment-critical signed webhooks stay on AttestPay's own
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

console.log(`attestpay server listening on :${port} · executor=${deps.relayer.kind}`);

export default { port, fetch: app.fetch, idleTimeout: 120 };
