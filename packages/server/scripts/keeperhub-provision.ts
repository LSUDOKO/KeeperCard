// Provision (or update) KeeperCard's KeeperHub workflows.
//
//   bun run keeperhub:provision              create/update by name, print env lines
//   bun run keeperhub:provision --dry-run    print the workflow JSON, touch nothing
//   bun run keeperhub:provision --out f.json also write ids + definitions to a file
//   bun run keeperhub:provision --no-hooks   force callback-free workflows (free plan)
//   bun run keeperhub:provision --hooks      force callbacks (assume Pro)
//
// Callbacks are probed, not assumed: KeeperHub gates the `HTTP Request` action behind
// the Pro plan and rejects a whole workflow containing one with 402 upgrade_required.
// On a free org the redemption and anchor workflows are built without their reporting
// node and KeeperCard polls for the execution record instead; recovery and sweep are skipped
// entirely, because a schedule plus a callback is all they ever were.
//
// Idempotent: a workflow whose name already exists in the organization is PATCHed in
// place (same id, so KEEPERHUB_WORKFLOW_* never changes); anything missing is created.
// Scheduled workflows are enabled; manual ones run disabled (API execution still works).
//
// Required env: KEEPERHUB_API_KEY, ATTESTPAY_PUBLIC_MCP_BASE (this API's public origin).
// Optional: KEEPERHUB_HOOK_SECRET (generated if absent), ATTESTPAY_CHAIN_ID,
// KEEPERHUB_RECEIPT_ANCHOR_ADDRESS, ATTESTPAY_7702_SPONSOR_PK, KEEPERHUB_RECOVERY_CRON, KEEPERHUB_SETTLE_CRON,
// KEEPERHUB_DISCORD_INTEGRATION_ID, KEEPERHUB_TELEGRAM_INTEGRATION_ID,
// KEEPERHUB_TELEGRAM_CHAT_ID, KEEPERHUB_SENDGRID_INTEGRATION_ID, KEEPERHUB_NOTIFY_EMAIL,
// KEEPERHUB_NOTIFY_WEBHOOK_URL.

import { isAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, keeperhub } from "@attestpay/engine";

const argv = new Set(process.argv.slice(2));
const dryRun = argv.has("--dry-run");
const outIdx = process.argv.indexOf("--out");
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : null;

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;
const die = (msg: string): never => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const publicBaseUrl = env("ATTESTPAY_PUBLIC_MCP_BASE") ?? die("ATTESTPAY_PUBLIC_MCP_BASE must be this API's public https origin");
let hookSecret = env("KEEPERHUB_HOOK_SECRET");
const generatedSecret = !hookSecret;
if (!hookSecret) hookSecret = `khs_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;

// KeeperHub gates the `HTTP Request` action behind the Pro plan, and a workflow that
// contains one is rejected wholesale with 402 upgrade_required. Ask the org what it may
// actually use, rather than building workflows the API will refuse. --hooks / --no-hooks
// override the probe (useful for a dry run, which never reaches the API).
const hooksFlag = argv.has("--hooks") ? true : argv.has("--no-hooks") ? false : null;

const config = keeperhub.keeperhubConfig() ?? die("KEEPERHUB_API_KEY is not set (create an org key at app.keeperhub.com → Settings → API Keys)");
const client = new keeperhub.KeeperHubClient(config);

let hooksEnabled = hooksFlag ?? false;
let planLabel = hooksFlag === null ? "unknown" : `forced by --${hooksFlag ? "" : "no-"}hooks`;
if (hooksFlag === null && !dryRun) {
  const features = await client.features();
  hooksEnabled = features.usableFeatureIds.has(keeperhub.HTTP_REQUEST_FEATURE_ID);
  planLabel = features.plan;
}

// The org wallet is needed up front: the treasury and fee workflows watch it.
const orgWallet = dryRun ? (config.walletAddress ?? null) : (config.walletAddress ?? (await client.walletAddress()));
const sponsorPk = env("ATTESTPAY_7702_SPONSOR_PK");
const sponsorWallet = sponsorPk
  ? privateKeyToAccount((sponsorPk.startsWith("0x") ? sponsorPk : `0x${sponsorPk}`) as `0x${string}`).address
  : null;

const anchor = env("KEEPERHUB_RECEIPT_ANCHOR_ADDRESS");
const defs = keeperhub.buildWorkflowDefinitions({
  chainId: CHAIN_ID,
  publicBaseUrl,
  hookSecret,
  hooksEnabled,
  paymentAnchorAddress: anchor && isAddress(anchor) ? (anchor as Address) : null,
  orgWallet,
  sponsorWallet,
  depegFloor: config.depegFloor ?? undefined,
  gasLimitMultiplier: env("KEEPERHUB_GAS_LIMIT_MULTIPLIER") ?? "1.5",
  schedules: {
    recovery: env("KEEPERHUB_RECOVERY_CRON"),
    sweep: env("KEEPERHUB_SETTLE_CRON"),
    treasury: env("KEEPERHUB_TREASURY_CRON"),
    market: env("KEEPERHUB_MARKET_CRON"),
  },
  notify: {
    discordIntegrationId: env("KEEPERHUB_DISCORD_INTEGRATION_ID"),
    telegramIntegrationId: env("KEEPERHUB_TELEGRAM_INTEGRATION_ID"),
    telegramChatId: env("KEEPERHUB_TELEGRAM_CHAT_ID"),
    sendgridIntegrationId: env("KEEPERHUB_SENDGRID_INTEGRATION_ID"),
    emailTo: env("KEEPERHUB_NOTIFY_EMAIL"),
    webhookUrl: env("KEEPERHUB_NOTIFY_WEBHOOK_URL"),
  },
});

if (dryRun) {
  // never print the real secret in a dry run
  const redacted = JSON.stringify(defs, null, 2).replaceAll(hookSecret, "<KEEPERHUB_HOOK_SECRET>");
  console.log(redacted);
  process.exit(0);
}

console.log(`KeeperHub provisioning · ${config.apiBase} · chain ${CHAIN_ID} · plan ${planLabel}`);
console.log(
  hooksEnabled
    ? `✓ HTTP Request available · workflows call back to ${publicBaseUrl}`
    : "! HTTP Request is Pro-gated · building callback-free workflows; KeeperCard polls KeeperHub instead",
);

// 1. the chains we execute on must be enabled in KeeperHub
const chains = await client.listChains();
for (const needed of [CHAIN_ID]) {
  const c = chains.find((x) => x.chainId === needed);
  if (!c?.isEnabled) die(`chain ${needed} is not enabled in KeeperHub`);
  console.log(`✓ chain ${needed} ${c!.name}${c!.usePrivateMempoolRpc ? " (private mempool available)" : ""}`);
}

// 2. the org wallet that will be msg.sender for every write
const wallet = orgWallet ?? die("the KeeperHub organization has no web3 wallet yet");
console.log(`✓ org wallet ${wallet}`);

// 3. create or update each workflow by name
const existing = await client.listWorkflows();
const ids: Partial<Record<keeperhub.KeeperHubWorkflowKey, string>> = {};
for (const key of keeperhub.KEEPERHUB_WORKFLOW_KEYS) {
  const def = defs[key];
  if (!def) {
    const why =
      key === "anchor" || key === "receipts"
        ? "KEEPERHUB_RECEIPT_ANCHOR_ADDRESS not set"
        : key === "notify"
          ? "no notification channel configured (KEEPERHUB_*_INTEGRATION_ID)"
          : (key === "recovery" || key === "sweep") && !hooksEnabled
            ? "schedule + callback is the whole workflow, and HTTP Request needs Pro; KeeperCard keeps its own timer"
            : "not applicable";
    console.log(`- ${keeperhub.KEEPERHUB_WORKFLOW_NAMES[key]}: skipped (${why})`);
    continue;
  }
  // Everything is enabled. A manual workflow executes through the API either way, but a
  // disabled one reads as switched off in KeeperHub's own UI; schedule, event and
  // transfer triggers genuinely never fire unless enabled.
  const enabled = true;
  const autonomous = keeperhub.AUTONOMOUS_WORKFLOWS.has(key);
  const found = existing.find((w) => w.name === def.name);
  const saved = found
    ? await client.updateWorkflow(found.id, { description: def.description, nodes: def.nodes, edges: def.edges, enabled })
    : await client.createWorkflow({ ...def, enabled }, `keepercard:provision:${def.name}:${CHAIN_ID}`);
  const id = saved.id ?? found?.id;
  if (!id) die(`KeeperHub returned no id for ${def.name}`);
  ids[key] = id;
  let validation = "";
  try {
    const v = await client.validateWorkflow(id!);
    const problems = (v.errors ?? v.issues ?? []) as unknown[];
    validation = Array.isArray(problems) && problems.length ? ` · ${problems.length} validation warning(s)` : " · valid";
  } catch {
    validation = " · validation unavailable";
  }
  console.log(`✓ ${def.name}: ${found ? "updated" : "created"} ${id} · ${keeperhub.KEEPERHUB_WORKFLOW_TRIGGERS[key]}${autonomous ? " (runs on its own)" : ""}${validation}`);
}

console.log("\nNo workflow env vars are needed: the server resolves these workflows by name at boot.");
console.log("Optional, to pin a specific workflow instead:\n");
for (const key of keeperhub.KEEPERHUB_WORKFLOW_KEYS) if (ids[key]) console.log(`  ${keeperhub.workflowEnvVar(key)}=${ids[key]}`);
if (generatedSecret && hooksEnabled) console.log(`\nKEEPERHUB_HOOK_SECRET=${hookSecret}   # generated now: set it, the workflows already carry it`);
console.log(`\nGas: ${wallet} pays when KeeperHub's gas sponsorship falls back. Keep a little ETH on chain ${CHAIN_ID}; treasury-monitor trips a Condition when it runs low.`);

if (outFile) {
  await Bun.write(
    outFile,
    JSON.stringify(
      { provisionedAt: new Date().toISOString(), chainId: CHAIN_ID, wallet, ids, definitions: JSON.parse(JSON.stringify(defs).replaceAll(hookSecret, "<KEEPERHUB_HOOK_SECRET>")) },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${outFile}`);
}
