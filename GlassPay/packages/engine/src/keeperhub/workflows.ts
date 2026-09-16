// The six KeeperHub workflows AttestPay runs on, as reviewable code.
//
// `bun run keeperhub:provision` pushes these to KeeperHub (create or update by name)
// and prints the workflow ids for the KEEPERHUB_WORKFLOW_* env vars. Node config keys
// are KeeperHub's own (plugins/web3 write-contract, HTTP Request, discord/telegram/
// sendgrid/webhook); template references use the {{@nodeId:Label.field}} form.
//
// Every HTTP callback into AttestPay is a NUDGE, not a claim: the hook handler
// re-reads the execution from KeeperHub's API before it touches the ledger, so a
// forged callback can at most make AttestPay look something up early.

import type { Address } from "viem";
import { DELEGATION_MANAGER } from "../chains";
import { REDEEM_DELEGATIONS_ABI } from "./calldata";
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from "./client";
import { KEEPERHUB_WORKFLOW_NAMES, type KeeperHubWorkflowKey } from "./config";

export const HOOK_SECRET_HEADER = "x-keepercard-hook-secret";

export const PAYMENT_ANCHOR_ABI = [
  {
    type: "function",
    name: "anchorPayment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "cardId", type: "bytes32" },
      { name: "payer", type: "address" },
      { name: "merchant", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "sourceChainId", type: "uint256" },
      { name: "sourceTxHash", type: "bytes32" },
      { name: "paidAt", type: "uint256" },
      { name: "memo", type: "string" },
    ],
    outputs: [],
  },
] as const;

export const ETHEREUM_SEPOLIA_CHAIN_ID = 11155111;

export type NotificationChannels = {
  discordIntegrationId?: string | null;
  telegramIntegrationId?: string | null;
  telegramChatId?: string | null;
  sendgridIntegrationId?: string | null;
  emailTo?: string | null;
  webhookUrl?: string | null;
};

export type WorkflowBuildOptions = {
  /** settlement chain for redemptions (Base 8453 / Base Sepolia 84532) */
  chainId: number;
  /** AttestPay's public API origin, e.g. https://attestpay-api.onrender.com */
  publicBaseUrl: string;
  hookSecret: string;
  /** PaymentAnchor on Ethereum Sepolia; omit to skip the cross-chain proof workflow */
  paymentAnchorAddress?: Address | null;
  anchorChainId?: number;
  gasLimitMultiplier?: string;
  /** use Flashbots Protect where KeeperHub supports it (Ethereum mainnet/Sepolia) */
  privateMempoolForAnchor?: boolean;
  notify?: NotificationChannels;
  schedules?: { recovery?: string; settle?: string };
};

const MARKER = "[keepercard]";

function trigger(id: string, label: string, config: Record<string, unknown>, x = 0): WorkflowNode {
  return { id, type: "trigger", position: { x, y: 0 }, data: { label, config } };
}

function action(id: string, label: string, config: Record<string, unknown>, x: number, y = 0, description?: string): WorkflowNode {
  return { id, type: "action", position: { x, y }, data: { label, ...(description ? { description } : {}), config } };
}

function edge(source: string, target: string, sourceHandle?: string): WorkflowEdge {
  return { id: `e-${source}-${target}${sourceHandle ? `-${sourceHandle}` : ""}`, source, target, ...(sourceHandle ? { sourceHandle } : {}) };
}

function hookRequest(
  id: string,
  label: string,
  opts: WorkflowBuildOptions,
  path: string,
  body: Record<string, string>,
  x: number,
  y = 0,
): WorkflowNode {
  return action(
    id,
    label,
    {
      actionType: "HTTP Request",
      endpoint: `${opts.publicBaseUrl.replace(/\/+$/, "")}/api/keeperhub/hooks/${path}`,
      httpMethod: "POST",
      httpHeaders: JSON.stringify({ "content-type": "application/json", [HOOK_SECRET_HEADER]: opts.hookSecret }),
      httpBody: JSON.stringify(body),
      timeout: 30,
      // a sleeping free-tier API must not fail the run that already moved the money
      failOnError: false,
      retryAttempts: 3,
      retryDelay: 5,
    },
    x,
    y,
    "Nudges AttestPay to re-read this execution from KeeperHub and update its ledger",
  );
}

function redemptionWorkflow(key: "pay" | "credit", opts: WorkflowBuildOptions): WorkflowDefinition {
  const t = "redemption-request";
  const tLabel = "Redemption Request";
  const name = KEEPERHUB_WORKFLOW_NAMES[key];
  const description =
    key === "pay"
      ? `${MARKER} Executes an AttestPay card payment: redeems the agent's pre-signed ERC-7710 delegation chain on DelegationManager. The calldata was dry-run and reviewed before this run started; nothing is re-derived here.`
      : `${MARKER} Executes an AttestPay credit line draw or repayment through the same reviewed-redemption path, with the caller's idempotency key carried in the plan digest.`;
  return {
    name,
    description,
    nodes: [
      trigger(t, tLabel, { triggerType: "Manual" }),
      action(
        "redeem",
        "Redeem Delegations",
        {
          actionType: "web3/write-contract",
          network: String(opts.chainId),
          web3Connection: "default",
          contractAddress: DELEGATION_MANAGER,
          abi: JSON.stringify(REDEEM_DELEGATIONS_ABI),
          abiFunction: "redeemDelegations",
          functionArgs: `{{@${t}:${tLabel}.functionArgs}}`,
          gasLimitMultiplier: opts.gasLimitMultiplier ?? "1.5",
          failOnError: "true",
        },
        280,
        0,
        "DelegationManager.redeemDelegations(permissionContexts, modes, executionCallDatas)",
      ),
      hookRequest(
        "report",
        "Report To AttestPay",
        opts,
        "execution",
        {
          workflow: name,
          digest: `{{@${t}:${tLabel}.digest}}`,
          chargeId: `{{@${t}:${tLabel}.chargeId}}`,
          cardId: `{{@${t}:${tLabel}.cardId}}`,
          transactionHash: "{{@redeem:Redeem Delegations.transactionHash}}",
        },
        560,
      ),
    ],
    edges: [edge(t, "redeem"), edge("redeem", "report")],
  };
}

function notificationNodes(opts: WorkflowBuildOptions, message: string, subject: string, x: number, y0 = 0): WorkflowNode[] {
  const n = opts.notify ?? {};
  const nodes: WorkflowNode[] = [];
  let y = y0;
  if (n.discordIntegrationId) {
    nodes.push(action("notify-discord", "Discord Alert", { actionType: "discord/send-message", integrationId: n.discordIntegrationId, discordMessage: message }, x, y));
    y += 140;
  }
  if (n.telegramIntegrationId && n.telegramChatId) {
    nodes.push(
      action("notify-telegram", "Telegram Alert", {
        actionType: "telegram/send-message",
        integrationId: n.telegramIntegrationId,
        chatId: n.telegramChatId,
        message,
      }, x, y),
    );
    y += 140;
  }
  if (n.sendgridIntegrationId && n.emailTo) {
    nodes.push(
      action("notify-email", "Email Alert", {
        actionType: "sendgrid/send-email",
        integrationId: n.sendgridIntegrationId,
        emailTo: n.emailTo,
        emailSubject: subject,
        emailBody: message,
      }, x, y),
    );
    y += 140;
  }
  if (n.webhookUrl) {
    nodes.push(
      action("notify-webhook", "Webhook Alert", {
        actionType: "webhook/send-webhook",
        webhookUrl: n.webhookUrl,
        webhookMethod: "POST",
        webhookHeaders: JSON.stringify({ "content-type": "application/json" }),
        webhookPayload: JSON.stringify({ source: "keepercard", subject, message }),
      }, x, y),
    );
  }
  return nodes;
}

export function hasNotificationChannel(n: NotificationChannels | undefined): boolean {
  if (!n) return false;
  return !!(n.discordIntegrationId || (n.telegramIntegrationId && n.telegramChatId) || (n.sendgridIntegrationId && n.emailTo) || n.webhookUrl);
}

function recoveryWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    trigger("schedule", "Every Five Minutes", {
      triggerType: "Schedule",
      scheduleCron: opts.schedules?.recovery ?? "*/5 * * * *",
      scheduleTimezone: "UTC",
    }),
    hookRequest("recover", "Recover Stuck Charges", opts, "recovery", { workflow: KEEPERHUB_WORKFLOW_NAMES.recovery }, 280),
    action(
      "still-stuck",
      "Charges Still Stuck",
      { actionType: "Condition", condition: "{{@recover:Recover Stuck Charges.data.still_pending}} > 0" },
      560,
    ),
  ];
  const edges = [edge("schedule", "recover"), edge("recover", "still-stuck")];
  const alerts = notificationNodes(
    opts,
    "KeeperCard: {{@recover:Recover Stuck Charges.data.still_pending}} charge(s) are still waiting on KeeperHub after the recovery pass.",
    "KeeperCard stuck charges",
    840,
  );
  for (const a of alerts) {
    nodes.push(a);
    edges.push(edge("still-stuck", a.id, "true"));
  }
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.recovery,
    description: `${MARKER} Replaces AttestPay's in-process reconcile sweep. On a KeeperHub schedule, AttestPay re-reads every non-terminal execution from KeeperHub (which owns nonce management, gas bumps and retries for stuck transactions) and settles its charge ledger from the verified result.`,
    nodes,
    edges,
  };
}

function settleWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition {
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.settle,
    description: `${MARKER} Replaces ATTESTPAY_FIAT_SETTLE_INTERVAL_MS. On a KeeperHub schedule, AttestPay lists approved-but-unsettled Visa charges and settles each one on-chain through card-payment-redemption.`,
    nodes: [
      trigger("schedule", "Every Two Minutes", {
        triggerType: "Schedule",
        scheduleCron: opts.schedules?.settle ?? "*/2 * * * *",
        scheduleTimezone: "UTC",
      }),
      hookRequest("settle", "Settle Approved Visa Charges", opts, "settle", { workflow: KEEPERHUB_WORKFLOW_NAMES.settle }, 280),
    ],
    edges: [edge("schedule", "settle")],
  };
}

function anchorWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition | null {
  if (!opts.paymentAnchorAddress) return null;
  const t = "payment-confirmed";
  const tLabel = "Payment Confirmed";
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.anchor,
    description: `${MARKER} Cross-chain proof, leg 1 of 2. Fires when an AttestPay charge confirms: anchors the payment on Ethereum Sepolia via PaymentAnchor.anchorPayment from KeeperHub's wallet (the ASC's trusted anchorer). Leg 2, AttestPayASC.verifyPayment on Creditcoin CC3, stays on AttestPay's direct path because KeeperHub does not support CC3.`,
    nodes: [
      trigger(t, tLabel, { triggerType: "Manual" }),
      action(
        "anchor",
        "Anchor Payment",
        {
          actionType: "web3/write-contract",
          network: String(opts.anchorChainId ?? ETHEREUM_SEPOLIA_CHAIN_ID),
          web3Connection: "default",
          contractAddress: opts.paymentAnchorAddress,
          abi: JSON.stringify(PAYMENT_ANCHOR_ABI),
          abiFunction: "anchorPayment",
          functionArgs: `{{@${t}:${tLabel}.functionArgs}}`,
          gasLimitMultiplier: opts.gasLimitMultiplier ?? "1.5",
          ...(opts.privateMempoolForAnchor ? { usePrivateMempool: true } : {}),
          failOnError: "true",
        },
        280,
        0,
        "PaymentAnchor.anchorPayment(cardId, payer, merchant, amount, sourceChainId, sourceTxHash, paidAt, memo)",
      ),
      hookRequest(
        "report",
        "Report Anchor To AttestPay",
        opts,
        "anchored",
        {
          workflow: KEEPERHUB_WORKFLOW_NAMES.anchor,
          chargeId: `{{@${t}:${tLabel}.chargeId}}`,
          transactionHash: "{{@anchor:Anchor Payment.transactionHash}}",
        },
        560,
      ),
    ],
    edges: [edge(t, "anchor"), edge("anchor", "report")],
  };
}

function notifyWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition | null {
  if (!hasNotificationChannel(opts.notify)) return null;
  const t = "event";
  const tLabel = "AttestPay Event";
  const nodes = [
    trigger(t, tLabel, { triggerType: "Manual" }),
    ...notificationNodes(opts, `{{@${t}:${tLabel}.message}}`, `{{@${t}:${tLabel}.subject}}`, 280),
  ];
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.notify,
    description: `${MARKER} Relays non-payment-critical AttestPay events (budget.low, dispute.opened, proof.failed) through KeeperHub's notification integrations. Payment-critical events stay on AttestPay's own HMAC-signed webhook queue.`,
    nodes,
    edges: nodes.slice(1).map((n) => edge(t, n.id)),
  };
}

/** Every workflow definition for this deployment. Null = not applicable (missing prerequisite). */
export function buildWorkflowDefinitions(opts: WorkflowBuildOptions): Record<KeeperHubWorkflowKey, WorkflowDefinition | null> {
  if (!/^https?:\/\//.test(opts.publicBaseUrl)) {
    throw new Error(`publicBaseUrl must be an absolute http(s) URL, got ${opts.publicBaseUrl}`);
  }
  if (opts.hookSecret.length < 24) throw new Error("hookSecret must be at least 24 characters");
  return {
    pay: redemptionWorkflow("pay", opts),
    credit: redemptionWorkflow("credit", opts),
    recovery: recoveryWorkflow(opts),
    settle: settleWorkflow(opts),
    anchor: anchorWorkflow(opts),
    notify: notifyWorkflow(opts),
  };
}

/** Workflows whose schedule trigger must be enabled to fire. Manual ones run disabled. */
export const SCHEDULED_WORKFLOWS: ReadonlySet<KeeperHubWorkflowKey> = new Set(["recovery", "settle"]);
