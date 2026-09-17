// KeeperHub configuration: the execution layer underneath KeeperCard's authorization
// layer. KeeperCard decides what an agent may spend; KeeperHub moves the money.
//
// Env conventions: an empty string is unset, public defaults where a default is safe,
// and a single function that says WHY the integration is off so the boot log can say
// it loudly.

import { isAddress, type Address } from "viem";

export const KEEPERHUB_ENV = {
  apiKey: "KEEPERHUB_API_KEY",
  apiBase: "KEEPERHUB_API_BASE",
  mcpUrl: "KEEPERHUB_MCP_URL",
  walletAddress: "KEEPERHUB_WALLET_ADDRESS",
  receiptAnchor: "KEEPERHUB_RECEIPT_ANCHOR_ADDRESS",
  guardedMinUsdc: "KEEPERHUB_GUARDED_MIN_USDC",
  depegFloor: "KEEPERHUB_DEPEG_FLOOR",
  dryRunRequired: "KEEPERHUB_DRY_RUN_REQUIRED",
  planTtlSeconds: "KEEPERHUB_PLAN_TTL_SECONDS",
  gasFeeUsdc: "KEEPERHUB_GAS_FEE_USDC",
  gasLimitMultiplier: "KEEPERHUB_GAS_LIMIT_MULTIPLIER",
  hookSecret: "KEEPERHUB_HOOK_SECRET",
  executor: "ATTESTPAY_EXECUTOR",
} as const;

export const DEFAULT_KEEPERHUB_API_BASE = "https://app.keeperhub.com/api";
export const DEFAULT_KEEPERHUB_MCP_URL = "https://app.keeperhub.com/mcp";

/**
 * Every workflow KeeperCard provisions in KeeperHub (docs/keeperhub/workflows.md).
 *
 * Four kinds, by what starts them:
 *   manual    pay · x402 · settle · guarded · anchor   — KeeperCard executes them per spend
 *   schedule  treasury · market                        — KeeperHub's own cron
 *   on-chain  receipts (Event) · fees (Transfer)       — KeeperHub watches the chain
 *   callback  recovery · sweep · notify                — need a Pro action or an integration
 */
export const KEEPERHUB_WORKFLOW_KEYS = [
  "pay",
  "x402",
  "settle",
  "guarded",
  "anchor",
  "receipts",
  "fees",
  "treasury",
  "market",
  "recovery",
  "sweep",
  "notify",
] as const;
export type KeeperHubWorkflowKey = (typeof KEEPERHUB_WORKFLOW_KEYS)[number];

export const KEEPERHUB_WORKFLOW_NAMES: Record<KeeperHubWorkflowKey, string> = {
  pay: "card-payment-redemption",
  x402: "x402-settlement",
  settle: "fiat-settlement",
  guarded: "guarded-card-payment",
  anchor: "payment-receipt-anchor",
  receipts: "receipt-event-watcher",
  fees: "fee-income-watcher",
  treasury: "treasury-monitor",
  market: "market-guard",
  recovery: "stuck-charge-recovery",
  sweep: "fiat-settlement-sweep",
  notify: "notification-relay",
};

/** What starts each workflow — shown in the dashboard and used by the provisioner. */
export const KEEPERHUB_WORKFLOW_TRIGGERS: Record<KeeperHubWorkflowKey, "Manual" | "Schedule" | "Event" | "Transfer"> = {
  pay: "Manual",
  x402: "Manual",
  settle: "Manual",
  guarded: "Manual",
  anchor: "Manual",
  receipts: "Event",
  fees: "Transfer",
  treasury: "Schedule",
  market: "Schedule",
  recovery: "Schedule",
  sweep: "Schedule",
  notify: "Manual",
};

/** `KEEPERHUB_WORKFLOW_<KEY>`: an explicit id. Optional — ids are resolved by name at boot. */
export const workflowEnvVar = (key: KeeperHubWorkflowKey): string => `KEEPERHUB_WORKFLOW_${key.toUpperCase()}`;

export type KeeperHubConfig = {
  apiKey: string;
  apiBase: string;
  mcpUrl: string;
  /** The org's Turnkey wallet. Resolved from /api/integrations when unset. */
  walletAddress: Address | null;
  workflows: Record<KeeperHubWorkflowKey, string | null>;
  /** Refuse to broadcast anything that was not dry-run first in the same call chain. */
  dryRunRequired: boolean;
  /** How long a reviewed plan (and its dry run) stays executable. */
  planTtlSeconds: number;
  /** USDC reimbursed to the KeeperHub wallet per redemption for the gas it fronts. */
  gasFeeUsdc: string;
  gasLimitMultiplier: string;
  /** Shared secret KeeperHub workflows present when they call back into KeeperCard. */
  hookSecret: string | null;
  /** PaymentAnchor on the settlement chain: where confirmed payments get an on-chain receipt. */
  receiptAnchorAddress: Address | null;
  /** Payments at or above this many USDC run through guarded-card-payment. Null = never. */
  guardedMinUsdc: string | null;
  /** Refuse a USDC payment when Chainlink's USDC/USD reads below this. Null disables the guard. */
  depegFloor: number | null;
};

export type ExecutorMode = "keeperhub" | "1shot";

type Env = Record<string, string | undefined>;

function read(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

/** Which execution layer this process uses. KeeperHub unless the operator explicitly
 * opts back into the legacy 1Shot relayer (the rollback lane, kept for one release). */
export function executorMode(env: Env = process.env): ExecutorMode {
  const raw = read(env, KEEPERHUB_ENV.executor)?.toLowerCase();
  if (raw === "1shot" || raw === "legacy" || raw === "legacy-1shot") return "1shot";
  if (raw && raw !== "keeperhub") {
    throw new Error(`${KEEPERHUB_ENV.executor}=${raw} is not a supported executor (keeperhub | 1shot)`);
  }
  return "keeperhub";
}

export function keeperhubConfig(env: Env = process.env): KeeperHubConfig | null {
  const apiKey = read(env, KEEPERHUB_ENV.apiKey);
  if (!apiKey) return null;
  const wallet = read(env, KEEPERHUB_ENV.walletAddress);
  const ttl = Number(read(env, KEEPERHUB_ENV.planTtlSeconds) ?? "600");
  const gasFee = read(env, KEEPERHUB_ENV.gasFeeUsdc) ?? "0.01";
  const anchor = read(env, KEEPERHUB_ENV.receiptAnchor);
  const guarded = read(env, KEEPERHUB_ENV.guardedMinUsdc);
  if (!/^\d+(\.\d{1,6})?$/.test(gasFee)) {
    throw new Error(`${KEEPERHUB_ENV.gasFeeUsdc}=${gasFee} is not a USDC decimal`);
  }
  return {
    apiKey,
    apiBase: (read(env, KEEPERHUB_ENV.apiBase) ?? DEFAULT_KEEPERHUB_API_BASE).replace(/\/+$/, ""),
    mcpUrl: read(env, KEEPERHUB_ENV.mcpUrl) ?? DEFAULT_KEEPERHUB_MCP_URL,
    walletAddress: wallet && isAddress(wallet) ? (wallet as Address) : null,
    workflows: Object.fromEntries(
      KEEPERHUB_WORKFLOW_KEYS.map((k) => [k, read(env, workflowEnvVar(k)) ?? null]),
    ) as Record<KeeperHubWorkflowKey, string | null>,
    // Default ON: the dry-run gate is the whole point of the integration.
    dryRunRequired: read(env, KEEPERHUB_ENV.dryRunRequired) !== "0",
    planTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 600,
    gasFeeUsdc: gasFee,
    gasLimitMultiplier: read(env, KEEPERHUB_ENV.gasLimitMultiplier) ?? "1.5",
    hookSecret: read(env, KEEPERHUB_ENV.hookSecret) ?? null,
    receiptAnchorAddress: anchor && isAddress(anchor) ? (anchor as Address) : null,
    guardedMinUsdc: guarded && /^\d+(\.\d{1,6})?$/.test(guarded) ? guarded : null,
    depegFloor: depegFloor(read(env, KEEPERHUB_ENV.depegFloor)),
  };
}

/** Default 0.98; "0"/"off" disables. A malformed value keeps the default rather than
 * silently turning a safety check off. */
function depegFloor(raw: string | undefined): number | null {
  if (raw === undefined) return 0.98;
  if (raw === "0" || raw.toLowerCase() === "off") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1.5 ? n : 0.98;
}

/** Why KeeperHub is not configured, or null when it is. */
export function keeperhubDisabledReason(env: Env = process.env): string | null {
  if (!read(env, KEEPERHUB_ENV.apiKey)) return `${KEEPERHUB_ENV.apiKey} is not set`;
  const wallet = read(env, KEEPERHUB_ENV.walletAddress);
  if (wallet && !isAddress(wallet)) return `${KEEPERHUB_ENV.walletAddress}=${wallet} is not an address`;
  return null;
}

/** Interval env vars whose in-process timers KeeperHub workflows replaced. Kept as
 * loud no-ops for one release so a rollback is a config change, not a revert. */
export const DEPRECATED_INTERVAL_VARS = [
  "ATTESTPAY_RECONCILE_INTERVAL_MS",
  "ATTESTPAY_FIAT_SETTLE_INTERVAL_MS",
  "ATTESTPAY_ATTESTCOIN_SWEEP_INTERVAL_MS",
] as const;
