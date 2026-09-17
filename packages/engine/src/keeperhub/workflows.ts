// The KeeperHub workflows KeeperCard runs on, as reviewable code.
//
// `bun run keeperhub:provision` pushes these to KeeperHub (create or update by name)
// and prints the workflow ids for the KEEPERHUB_WORKFLOW_* env vars. Node config keys
// are KeeperHub's own (plugins/web3 write-contract, HTTP Request, discord/telegram/
// sendgrid/webhook); template references use the {{@nodeId:Label.field}} form.
//
// Every HTTP callback into KeeperCard is a NUDGE, not a claim: the hook handler
// re-reads the execution from KeeperHub's API before it touches the ledger, so a
// forged callback can at most make KeeperCard look something up early.

import type { Address } from "viem";
import { CHAINS, DELEGATION_MANAGER } from "../chains";
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

/**
 * The event `anchorPayment` emits. Kept beside the function ABI because the audit trail
 * reads these back through KeeperHub to check AttestPay's own records against the chain.
 */
export const PAYMENT_ANCHOR_EVENT_ABI = [
  {
    type: "event",
    name: "PaymentAnchored",
    inputs: [
      { name: "cardId", type: "bytes32", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "merchant", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "sourceChainId", type: "uint256", indexed: false },
      { name: "sourceTxHash", type: "bytes32", indexed: false },
      { name: "paidAt", type: "uint256", indexed: false },
      { name: "anchoredBy", type: "address", indexed: false },
      { name: "memo", type: "string", indexed: false },
    ],
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
  /** KeeperCard's public API origin, e.g. https://keepercard-api.example */
  publicBaseUrl: string;
  hookSecret: string;
  /** PaymentAnchor address; omit to skip the receipt workflows */
  paymentAnchorAddress?: Address | null;
  /** chain the PaymentAnchor lives on. Defaults to the settlement chain, so a receipt is
   * written where the payment it describes actually happened. */
  anchorChainId?: number;
  gasLimitMultiplier?: string;
  /**
   * Emit the HTTP Request callback nodes. KeeperHub gates the `HTTP Request` action
   * behind the Pro plan, so this is off unless the org's plan allows it. The callbacks
   * are only ever a nudge (see the header note), so without them KeeperCard polls
   * KeeperHub for the same execution record instead of being pushed — same source of
   * truth, same ledger writes, one extra round trip.
   */
  hooksEnabled?: boolean;
  /** The org's KeeperHub wallet: what the treasury and fee workflows watch. */
  orgWallet?: Address | null;
  /** The EIP-7702 sponsor wallet, watched alongside the org wallet when set. */
  sponsorWallet?: Address | null;
  /** Chain the Chainlink reference feeds are read on. The USDC/USD feed exists on Base
   * mainnet but not Base Sepolia; a read costs no gas, so a testnet deployment still
   * reads the mainnet reference price. */
  feedChainId?: number;
  /** USDC/USD below this trips the market-guard Condition (default 0.98). */
  depegFloor?: number;
  /** Risk score at or above which guarded-card-payment refuses to redeem (default 90). */
  riskCeiling?: number;
  notify?: NotificationChannels;
  schedules?: { recovery?: string; sweep?: string; treasury?: string; market?: string };
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
    "Nudges KeeperCard to re-read this execution from KeeperHub and update its ledger",
  );
}

/** The write every redemption workflow ends in. */
function redeemNode(opts: WorkflowBuildOptions, triggerId: string, triggerLabel: string, x: number): WorkflowNode {
  return action(
    "redeem",
    "Redeem Delegations",
    {
      actionType: "web3/write-contract",
      network: String(opts.chainId),
      contractAddress: DELEGATION_MANAGER,
      abi: JSON.stringify(REDEEM_DELEGATIONS_ABI),
      abiFunction: "redeemDelegations",
      functionArgs: `{{@${triggerId}:${triggerLabel}.functionArgs}}`,
      gasLimitMultiplier: opts.gasLimitMultiplier ?? "1.5",
      failOnError: "true",
    },
    x,
    0,
    "DelegationManager.redeemDelegations(permissionContexts, modes, executionCallDatas)",
  );
}

const REDEMPTION_DESCRIPTIONS: Record<"pay" | "x402" | "settle", string> = {
  pay: "Executes a KeeperCard card payment: redeems the agent's pre-signed ERC-7710 delegation chain on DelegationManager. The calldata was dry-run and reviewed before this run started; nothing is re-derived here.",
  x402: "Settles an x402 payment for the KeeperCard facilitator: the same reviewed ERC-7710 redemption as a card payment, kept in its own workflow so paid-API traffic has its own execution history.",
  settle: "Settles an approved Visa authorization on-chain: the delegated USDC transfer that backs a fiat charge, kept separate from agent-initiated payments so settlement runs are auditable on their own.",
};

function redemptionWorkflow(key: "pay" | "x402" | "settle", opts: WorkflowBuildOptions): WorkflowDefinition {
  const t = "redemption-request";
  const tLabel = "Redemption Request";
  const name = KEEPERHUB_WORKFLOW_NAMES[key];
  return {
    name,
    description: `${MARKER} ${REDEMPTION_DESCRIPTIONS[key]}`,
    nodes: [
      trigger(t, tLabel, { triggerType: "Manual" }),
      redeemNode(opts, t, tLabel, 280),
      ...(opts.hooksEnabled
        ? [
            hookRequest(
              "report",
              "Report To KeeperCard",
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
          ]
        : []),
    ],
    edges: opts.hooksEnabled ? [edge(t, "redeem"), edge("redeem", "report")] : [edge(t, "redeem")],
  };
}

/**
 * A payment that KeeperHub itself refuses to broadcast when its risk read is critical.
 *
 * The ordinary pay workflow reads risk during the dry run, where it is advisory. Here
 * the check sits INSIDE the workflow, between the trigger and the write: the redemption
 * node is only reachable through the Condition's `true` branch. KeeperHub's assessor is
 * fail-closed (70 when its backend is down), so the ceiling defaults to 90 — a lagging
 * risk service must not stop payments, but a critical verdict does.
 */
function guardedWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition {
  const t = "redemption-request";
  const tLabel = "Redemption Request";
  const ceiling = opts.riskCeiling ?? 90;
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.guarded,
    description: `${MARKER} A high-value KeeperCard payment with the risk check inside the workflow: KeeperHub assesses the exact redemption calldata, and the write is only reachable when the score is below ${ceiling}. A critical verdict ends the run without broadcasting anything.`,
    nodes: [
      trigger(t, tLabel, { triggerType: "Manual" }),
      action(
        "risk",
        "Assess Risk",
        {
          actionType: "web3/assess-risk",
          calldata: `{{@${t}:${tLabel}.calldata}}`,
          contractAddress: DELEGATION_MANAGER,
          value: "0",
          chain: String(opts.chainId),
          ...(opts.orgWallet ? { senderAddress: opts.orgWallet } : {}),
        },
        280,
      ),
      action("acceptable", "Risk Acceptable", { actionType: "Condition", condition: `{{@risk:Assess Risk.riskScore}} < ${ceiling}` }, 560),
      redeemNode(opts, t, tLabel, 840),
    ],
    edges: [edge(t, "risk"), edge("risk", "acceptable"), edge("acceptable", "redeem", "true")],
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
  // Send Webhook is a Pro action like HTTP Request: emitting it on a free org would get
  // the whole workflow rejected with 402.
  if (n.webhookUrl && opts.hooksEnabled) {
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

function hasNotificationChannel(n: NotificationChannels | undefined, hooksEnabled: boolean | undefined): boolean {
  if (!n) return false;
  return !!(n.discordIntegrationId || (n.telegramIntegrationId && n.telegramChatId) || (n.sendgridIntegrationId && n.emailTo) || (n.webhookUrl && hooksEnabled));
}

function recoveryWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition | null {
  // The schedule exists purely to call back into KeeperCard, so without the HTTP
  // Request action there is no workflow left to build — a lone trigger is invalid.
  // KeeperCard keeps its own reconcile timer in that case (see index.ts).
  if (!opts.hooksEnabled) return null;
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
    description: `${MARKER} Replaces KeeperCard's in-process reconcile sweep. On a KeeperHub schedule, KeeperCard re-reads every non-terminal execution from KeeperHub (which owns nonce management, gas bumps and retries for stuck transactions) and settles its charge ledger from the verified result.`,
    nodes,
    edges,
  };
}

function sweepWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition | null {
  // Same as recoveryWorkflow: schedule + callback is the whole workflow.
  if (!opts.hooksEnabled) return null;
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.sweep,
    description: `${MARKER} Replaces the in-process fiat settlement timer. On a KeeperHub schedule, KeeperCard lists approved-but-unsettled Visa charges and settles each one on-chain through the fiat-settlement workflow.`,
    nodes: [
      trigger("schedule", "Every Two Minutes", {
        triggerType: "Schedule",
        scheduleCron: opts.schedules?.sweep ?? "*/2 * * * *",
        scheduleTimezone: "UTC",
      }),
      hookRequest("settle", "Settle Approved Visa Charges", opts, "settle", { workflow: KEEPERHUB_WORKFLOW_NAMES.sweep }, 280),
    ],
    edges: [edge("schedule", "settle")],
  };
}

/** Chain the receipt anchor lives on: the settlement chain unless told otherwise. */
const anchorChain = (opts: WorkflowBuildOptions): number => opts.anchorChainId ?? opts.chainId;

function anchorWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition | null {
  if (!opts.paymentAnchorAddress) return null;
  const t = "payment-confirmed";
  const tLabel = "Payment Confirmed";
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.anchor,
    description: `${MARKER} Writes an on-chain receipt for a confirmed KeeperCard payment: PaymentAnchor.anchorPayment records the card, payer, merchant, amount and source transaction from KeeperHub's wallet, so an agent's payment history is a public, append-only record rather than a row in KeeperCard's database.`,
    nodes: [
      trigger(t, tLabel, { triggerType: "Manual" }),
      action(
        "anchor",
        "Anchor Payment",
        {
          actionType: "web3/write-contract",
          network: String(anchorChain(opts)),
          contractAddress: opts.paymentAnchorAddress,
          abi: JSON.stringify(PAYMENT_ANCHOR_ABI),
          abiFunction: "anchorPayment",
          functionArgs: `{{@${t}:${tLabel}.functionArgs}}`,
          gasLimitMultiplier: opts.gasLimitMultiplier ?? "1.5",
          failOnError: "true",
        },
        280,
        0,
        "PaymentAnchor.anchorPayment(cardId, payer, merchant, amount, sourceChainId, sourceTxHash, paidAt, memo)",
      ),
      ...(opts.hooksEnabled
        ? [
            hookRequest(
              "report",
              "Report Anchor To KeeperCard",
              opts,
              "anchored",
              {
                workflow: KEEPERHUB_WORKFLOW_NAMES.anchor,
                chargeId: `{{@${t}:${tLabel}.chargeId}}`,
                transactionHash: "{{@anchor:Anchor Payment.transactionHash}}",
              },
              560,
            ),
          ]
        : []),
    ],
    edges: opts.hooksEnabled ? [edge(t, "anchor"), edge("anchor", "report")] : [edge(t, "anchor")],
  };
}

/**
 * KeeperHub watching the chain for KeeperCard's own receipts. Every PaymentAnchored
 * event starts a run that re-reads the recent anchors, so KeeperHub's execution history
 * holds an independent, chain-triggered record of each receipt — one KeeperCard did not
 * write and cannot forget to write.
 */
function receiptsWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition | null {
  if (!opts.paymentAnchorAddress) return null;
  const network = String(anchorChain(opts));
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.receipts,
    description: `${MARKER} Chain-triggered: fires on every PaymentAnchored event and re-reads the recent receipts from the chain. KeeperHub's run history becomes a record of KeeperCard's receipts that KeeperCard itself did not write.`,
    nodes: [
      trigger("anchored", "Payment Anchored", {
        triggerType: "Event",
        network,
        contractAddress: opts.paymentAnchorAddress,
        contractABI: JSON.stringify(PAYMENT_ANCHOR_EVENT_ABI),
        eventName: "PaymentAnchored",
      }),
      action(
        "recent",
        "Recent Receipts",
        {
          actionType: "web3/query-events",
          network,
          contractAddress: opts.paymentAnchorAddress,
          abi: JSON.stringify(PAYMENT_ANCHOR_EVENT_ABI),
          eventName: "PaymentAnchored",
          blockCount: "2000",
        },
        280,
      ),
    ],
    edges: [edge("anchored", "recent")],
  };
}

/** Fee income: every USDC transfer into the org wallet (the gas-fee leg of a payment). */
function feesWorkflow(opts: WorkflowBuildOptions, usdc: Address): WorkflowDefinition | null {
  if (!opts.orgWallet) return null;
  const network = String(opts.chainId);
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.fees,
    description: `${MARKER} Chain-triggered: fires when USDC arrives in the KeeperHub wallet — the gas-fee leg every KeeperCard payment carries — and reads the wallet's running USDC balance, so fee income is tracked by KeeperHub from the chain rather than inferred from KeeperCard's ledger.`,
    nodes: [
      trigger("fee", "Fee Received", { triggerType: "Transfer", network, contractAddress: usdc, recipientAddress: opts.orgWallet }),
      action("balance", "Fee Balance", { actionType: "web3/check-token-balance", network, address: opts.orgWallet, tokenConfig: usdc }, 280),
    ],
    edges: [edge("fee", "balance")],
  };
}

/** Scheduled health of the wallets payments depend on. */
function treasuryWorkflow(opts: WorkflowBuildOptions, usdc: Address): WorkflowDefinition | null {
  if (!opts.orgWallet) return null;
  const network = String(opts.chainId);
  const nodes: WorkflowNode[] = [
    trigger("tick", "Every Ten Minutes", {
      triggerType: "Schedule",
      scheduleCron: opts.schedules?.treasury ?? "*/10 * * * *",
      scheduleTimezone: "UTC",
    }),
    action("gas", "Org Wallet Gas", { actionType: "web3/check-balance", network, address: opts.orgWallet }, 280),
    action("usdc", "Org Wallet USDC", { actionType: "web3/check-token-balance", network, address: opts.orgWallet, tokenConfig: usdc }, 560),
  ];
  const edges = [edge("tick", "gas"), edge("gas", "usdc")];
  let last = "usdc";
  let x = 840;
  if (opts.sponsorWallet) {
    nodes.push(action("sponsor", "Sponsor Wallet Gas", { actionType: "web3/check-balance", network, address: opts.sponsorWallet }, x));
    edges.push(edge(last, "sponsor"));
    last = "sponsor";
    x += 280;
  }
  // Gas sponsorship can fall back to the wallet paying for itself; an empty wallet then
  // fails every payment at KeeperHub's own preflight. 0.0001 ETH is ~400 redemptions.
  nodes.push(action("low", "Gas Running Low", { actionType: "Condition", condition: "{{@gas:Org Wallet Gas.balance}} < 0.0001" }, x));
  edges.push(edge(last, "low"));
  for (const a of notificationNodes(opts, "KeeperCard: the KeeperHub wallet is low on gas ({{@gas:Org Wallet Gas.balance}} ETH). Payments will start failing at KeeperHub's gas preflight.", "KeeperCard gas low", x + 280)) {
    nodes.push(a);
    edges.push(edge("low", a.id, "true"));
  }
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.treasury,
    description: `${MARKER} Scheduled: reads the gas and USDC balances of the wallets KeeperCard payments depend on, and trips a Condition when the KeeperHub wallet's gas runs low — the failure that otherwise only shows up as a payment refused at KeeperHub's preflight.`,
    nodes,
    edges,
  };
}

const chainlinkMeta = (contractKey: string, slug: string) =>
  JSON.stringify({ protocolSlug: "chainlink", contractKey, functionName: "latestRoundData", actionType: `chainlink/${slug}` });

/** Scheduled Chainlink reference prices, with a depeg Condition on USDC/USD. */
function marketWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition {
  const network = String(opts.feedChainId ?? 8453);
  const floor = opts.depegFloor ?? 0.98;
  // Base's USDC/USD aggregator reports 18 decimals (not the usual 8)
  const floorScaled = BigInt(Math.round(floor * 1e6)) * 10n ** 12n;
  const nodes: WorkflowNode[] = [
    trigger("tick", "Hourly", { triggerType: "Schedule", scheduleCron: opts.schedules?.market ?? "0 * * * *", scheduleTimezone: "UTC" }),
    action("usdc", "USDC USD Feed", { actionType: "chainlink/usdc-usd-latest-round-data", network, _protocolMeta: chainlinkMeta("usdcUsd", "usdc-usd-latest-round-data") }, 280),
    action("eth", "ETH USD Feed", { actionType: "chainlink/eth-usd-latest-round-data", network, _protocolMeta: chainlinkMeta("ethUsd", "eth-usd-latest-round-data") }, 560),
    action("depeg", "USDC Below Peg", { actionType: "Condition", condition: `{{@usdc:USDC USD Feed.answer}} < ${floorScaled.toString()}` }, 840),
  ];
  const edges = [edge("tick", "usdc"), edge("usdc", "eth"), edge("eth", "depeg")];
  for (const a of notificationNodes(opts, `KeeperCard: Chainlink USDC/USD read below ${floor}. Card payments are being refused until it recovers.`, "KeeperCard USDC depeg", 1120)) {
    nodes.push(a);
    edges.push(edge("depeg", a.id, "true"));
  }
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.market,
    description: `${MARKER} Scheduled: reads Chainlink's USDC/USD and ETH/USD reference feeds and trips a Condition when USDC falls below ${floor}. Cards are denominated in USDC, so a depeg silently changes what every budget is worth; the same feed gates the payment dry run.`,
    nodes,
    edges,
  };
}

function notifyWorkflow(opts: WorkflowBuildOptions): WorkflowDefinition | null {
  if (!hasNotificationChannel(opts.notify, opts.hooksEnabled)) return null;
  const t = "event";
  const tLabel = "KeeperCard Event";
  const nodes = [
    trigger(t, tLabel, { triggerType: "Manual" }),
    ...notificationNodes(opts, `{{@${t}:${tLabel}.message}}`, `{{@${t}:${tLabel}.subject}}`, 280),
  ];
  return {
    name: KEEPERHUB_WORKFLOW_NAMES.notify,
    description: `${MARKER} Relays non-payment-critical KeeperCard events (budget.low, dispute.opened, card.frozen) through KeeperHub's notification integrations. Payment-critical events stay on KeeperCard's own HMAC-signed webhook queue.`,
    nodes,
    edges: nodes.slice(1).map((n) => edge(t, n.id)),
  };
}

/** Every workflow definition for this deployment. Null = not applicable (missing prerequisite). */
export function buildWorkflowDefinitions(opts: WorkflowBuildOptions): Record<KeeperHubWorkflowKey, WorkflowDefinition | null> {
  if (!/^https?:\/\//.test(opts.publicBaseUrl)) {
    throw new Error(`publicBaseUrl must be an absolute http(s) URL, got ${opts.publicBaseUrl}`);
  }
  // Only meaningful when callbacks exist; the free plan has no HTTP Request node to carry it.
  if (opts.hooksEnabled && opts.hookSecret.length < 24) throw new Error("hookSecret must be at least 24 characters");
  const usdc = (CHAINS as Record<number, { usdc: Address }>)[opts.chainId]?.usdc;
  if (!usdc) throw new Error(`no USDC address known for chain ${opts.chainId}`);
  return {
    pay: redemptionWorkflow("pay", opts),
    x402: redemptionWorkflow("x402", opts),
    settle: redemptionWorkflow("settle", opts),
    guarded: guardedWorkflow(opts),
    anchor: anchorWorkflow(opts),
    receipts: receiptsWorkflow(opts),
    fees: feesWorkflow(opts, usdc),
    treasury: treasuryWorkflow(opts, usdc),
    market: marketWorkflow(opts),
    recovery: recoveryWorkflow(opts),
    sweep: sweepWorkflow(opts),
    notify: notifyWorkflow(opts),
  };
}

/** Workflows nothing in KeeperCard starts: KeeperHub's scheduler or the chain does, so
 * they only ever run if they are enabled. */
export const AUTONOMOUS_WORKFLOWS: ReadonlySet<KeeperHubWorkflowKey> = new Set(["receipts", "fees", "treasury", "market", "recovery", "sweep"]);
/** @deprecated use AUTONOMOUS_WORKFLOWS */
export const SCHEDULED_WORKFLOWS = AUTONOMOUS_WORKFLOWS;
