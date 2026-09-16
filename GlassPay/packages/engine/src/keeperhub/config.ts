// KeeperHub configuration: the execution layer underneath AttestPay's authorization
// layer. AttestPay decides what an agent may spend; KeeperHub moves the money.
//
// Same env conventions as the Attestcoin integration (attestcoin/config.ts): an empty
// string is unset, public defaults where a default is safe, and a single function
// that says WHY the integration is off so the boot log can say it loudly.

import { isAddress, type Address } from "viem";

export const KEEPERHUB_ENV = {
  apiKey: "KEEPERHUB_API_KEY",
  apiBase: "KEEPERHUB_API_BASE",
  mcpUrl: "KEEPERHUB_MCP_URL",
  walletAddress: "KEEPERHUB_WALLET_ADDRESS",
  workflowPay: "KEEPERHUB_WORKFLOW_PAY",
  workflowRecovery: "KEEPERHUB_WORKFLOW_RECOVERY",
  workflowSettle: "KEEPERHUB_WORKFLOW_SETTLE",
  workflowAnchor: "KEEPERHUB_WORKFLOW_ANCHOR",
  workflowCredit: "KEEPERHUB_WORKFLOW_CREDIT",
  workflowNotify: "KEEPERHUB_WORKFLOW_NOTIFY",
  dryRunRequired: "KEEPERHUB_DRY_RUN_REQUIRED",
  planTtlSeconds: "KEEPERHUB_PLAN_TTL_SECONDS",
  gasFeeUsdc: "KEEPERHUB_GAS_FEE_USDC",
  gasLimitMultiplier: "KEEPERHUB_GAS_LIMIT_MULTIPLIER",
  hookSecret: "KEEPERHUB_HOOK_SECRET",
  executor: "ATTESTPAY_EXECUTOR",
} as const;

export const DEFAULT_KEEPERHUB_API_BASE = "https://app.keeperhub.com/api";
export const DEFAULT_KEEPERHUB_MCP_URL = "https://app.keeperhub.com/mcp";

/** The six workflows AttestPay provisions in KeeperHub (docs/keeperhub/workflows.md). */
export const KEEPERHUB_WORKFLOW_KEYS = ["pay", "recovery", "settle", "anchor", "credit", "notify"] as const;
export type KeeperHubWorkflowKey = (typeof KEEPERHUB_WORKFLOW_KEYS)[number];

export const KEEPERHUB_WORKFLOW_NAMES: Record<KeeperHubWorkflowKey, string> = {
  pay: "card-payment-redemption",
  recovery: "stuck-charge-recovery",
  settle: "fiat-settlement-sweep",
  anchor: "attestcoin-cross-chain-proof",
  credit: "credit-line-draw-repay",
  notify: "notification-relay",
};

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
  /** Shared secret KeeperHub workflows present when they call back into AttestPay. */
  hookSecret: string | null;
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
  if (!/^\d+(\.\d{1,6})?$/.test(gasFee)) {
    throw new Error(`${KEEPERHUB_ENV.gasFeeUsdc}=${gasFee} is not a USDC decimal`);
  }
  return {
    apiKey,
    apiBase: (read(env, KEEPERHUB_ENV.apiBase) ?? DEFAULT_KEEPERHUB_API_BASE).replace(/\/+$/, ""),
    mcpUrl: read(env, KEEPERHUB_ENV.mcpUrl) ?? DEFAULT_KEEPERHUB_MCP_URL,
    walletAddress: wallet && isAddress(wallet) ? (wallet as Address) : null,
    workflows: {
      pay: read(env, KEEPERHUB_ENV.workflowPay) ?? null,
      recovery: read(env, KEEPERHUB_ENV.workflowRecovery) ?? null,
      settle: read(env, KEEPERHUB_ENV.workflowSettle) ?? null,
      anchor: read(env, KEEPERHUB_ENV.workflowAnchor) ?? null,
      credit: read(env, KEEPERHUB_ENV.workflowCredit) ?? null,
      notify: read(env, KEEPERHUB_ENV.workflowNotify) ?? null,
    },
    // Default ON: the dry-run gate is the whole point of the integration.
    dryRunRequired: read(env, KEEPERHUB_ENV.dryRunRequired) !== "0",
    planTtlSeconds: Number.isFinite(ttl) && ttl > 0 ? ttl : 600,
    gasFeeUsdc: gasFee,
    gasLimitMultiplier: read(env, KEEPERHUB_ENV.gasLimitMultiplier) ?? "1.5",
    hookSecret: read(env, KEEPERHUB_ENV.hookSecret) ?? null,
  };
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
