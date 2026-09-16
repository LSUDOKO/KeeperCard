// notification-relay: non-payment-critical AttestPay events go out through KeeperHub's
// notification integrations (Discord / Telegram / SendGrid / webhook nodes) instead of
// AttestPay's own retry queue. Payment-critical events (charge.confirmed, proof.verified,
// card.revoked, ...) deliberately stay on AttestPay's HMAC-signed webhooks: the core
// audit trail does not take a new dependency.

import { keeperhub } from "@attestpay/engine";
import type { AppDeps } from "../deps";
import type { EventRow, EventType } from "../events/store";

export const RELAYED_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  "budget.low",
  "dispute.opened",
  "dispute.resolved",
  "proof.failed",
  "fact.failed",
  "card.frozen",
]);

export function notificationText(ev: EventRow, cardName: string | null): { subject: string; message: string } {
  const card = cardName ? `"${cardName}"` : ev.card_id ? `card ${ev.card_id.slice(0, 8)}` : "your account";
  const d = ev.data as Record<string, unknown>;
  switch (ev.type) {
    case "budget.low":
      return {
        subject: `KeeperCard: ${card} is running low`,
        message: `KeeperCard budget alert: ${card} has ${d.remaining_this_period ?? "little"} of ${d.period_budget ?? "?"} USDC left this period (${d.remaining_pct ?? "?"}%, alert at ${d.threshold_pct ?? "?"}%).`,
      };
    case "dispute.opened":
      return { subject: `KeeperCard: dispute opened on ${card}`, message: `A payment from ${card} is disputed (charge ${String(d.charge_id ?? "?")}).` };
    case "dispute.resolved":
      return { subject: `KeeperCard: dispute resolved on ${card}`, message: `A dispute on ${card} resolved: ${String(d.outcome ?? "see dashboard")}.` };
    case "proof.failed":
    case "fact.failed":
      return {
        subject: `KeeperCard: cross-chain proof failed`,
        message: `Cross-chain verification failed for ${card}: ${String(d.error ?? "unknown error")}. Payments are unaffected; retry from the dashboard.`,
      };
    case "card.frozen":
      return { subject: `KeeperCard: ${card} frozen`, message: `${card} was frozen. Spends are refused until it is unfrozen.` };
    default:
      return { subject: `KeeperCard: ${ev.type}`, message: `${ev.type} on ${card}` };
  }
}

/** Subscribes the relay to the event bus when the notify workflow is provisioned. */
export function installNotificationRelay(deps: AppDeps): boolean {
  const kh = deps.keeperhub;
  const workflowId = kh?.config?.workflows.notify;
  if (!deps.events || !kh?.client || !workflowId) return false;
  const client = kh.client;
  deps.events.subscribe((ev) => {
    if (!RELAYED_EVENTS.has(ev.type)) return;
    const card = ev.card_id ? deps.store.getCard(ev.card_id) : null;
    const { subject, message } = notificationText(ev, card?.name ?? null);
    void client
      .executeWorkflow(workflowId, { event: ev.type, subject, message, cardId: ev.card_id ?? "" }, `keepercard:notify:${ev.id}`)
      .then((run) =>
        kh.store.record({
          execution_id: run.executionId,
          surface: "workflow",
          workflow_key: "notify",
          workflow_id: workflowId,
          action: "notify",
          card_id: ev.card_id,
          charge_id: null,
          digest: null,
          status: "running",
          tx_hash: null,
          chain_id: null,
          error: null,
          detail: { event: ev.type, event_id: ev.id },
        }),
      )
      .catch((e) =>
        keeperhub.emitKeeperHubExecutionFailed({
          executionId: null,
          workflow: "notify",
          reason: e instanceof Error ? e.message : String(e),
          cardId: ev.card_id,
        }),
      );
  });
  console.log(`[keeperhub] notification-relay active (${workflowId}) for ${[...RELAYED_EVENTS].join(", ")}`);
  return true;
}
