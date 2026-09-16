// Provision (or update) AttestPay's six KeeperHub workflows.
//
//   bun run keeperhub:provision              create/update by name, print env lines
//   bun run keeperhub:provision --dry-run    print the workflow JSON, touch nothing
//   bun run keeperhub:provision --out f.json also write ids + definitions to a file
//
// Idempotent: a workflow whose name already exists in the organization is PATCHed in
// place (same id, so KEEPERHUB_WORKFLOW_* never changes); anything missing is created.
// Scheduled workflows are enabled; manual ones run disabled (API execution still works).
//
// Required env: KEEPERHUB_API_KEY, ATTESTPAY_PUBLIC_MCP_BASE (this API's public origin).
// Optional: KEEPERHUB_HOOK_SECRET (generated if absent), ATTESTPAY_CHAIN_ID,
// ATTESTPAY_PAYMENT_ANCHOR_ADDRESS, KEEPERHUB_RECOVERY_CRON, KEEPERHUB_SETTLE_CRON,
// KEEPERHUB_DISCORD_INTEGRATION_ID, KEEPERHUB_TELEGRAM_INTEGRATION_ID,
// KEEPERHUB_TELEGRAM_CHAT_ID, KEEPERHUB_SENDGRID_INTEGRATION_ID, KEEPERHUB_NOTIFY_EMAIL,
// KEEPERHUB_NOTIFY_WEBHOOK_URL.

import { isAddress, type Address } from "viem";
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

const anchor = env("ATTESTPAY_PAYMENT_ANCHOR_ADDRESS");
const defs = keeperhub.buildWorkflowDefinitions({
  chainId: CHAIN_ID,
  publicBaseUrl,
  hookSecret,
  paymentAnchorAddress: anchor && isAddress(anchor) ? (anchor as Address) : null,
  gasLimitMultiplier: env("KEEPERHUB_GAS_LIMIT_MULTIPLIER") ?? "1.5",
  schedules: { recovery: env("KEEPERHUB_RECOVERY_CRON"), settle: env("KEEPERHUB_SETTLE_CRON") },
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

const config = keeperhub.keeperhubConfig() ?? die("KEEPERHUB_API_KEY is not set (create an org key at app.keeperhub.com → Settings → API Keys)");
const client = new keeperhub.KeeperHubClient(config);

console.log(`KeeperHub provisioning · ${config.apiBase} · chain ${CHAIN_ID} · hooks → ${publicBaseUrl}`);

// 1. the chains we execute on must be enabled in KeeperHub
const chains = await client.listChains();
for (const needed of [CHAIN_ID, ...(defs.anchor ? [keeperhub.ETHEREUM_SEPOLIA_CHAIN_ID] : [])]) {
  const c = chains.find((x) => x.chainId === needed);
  if (!c?.isEnabled) die(`chain ${needed} is not enabled in KeeperHub`);
  console.log(`✓ chain ${needed} ${c!.name}${c!.usePrivateMempoolRpc ? " (private mempool available)" : ""}`);
}

// 2. the org wallet that will be msg.sender for every write
const wallet = config.walletAddress ?? (await client.walletAddress()) ?? die("the KeeperHub organization has no web3 wallet yet");
console.log(`✓ org wallet ${wallet}`);

// 3. create or update each workflow by name
const existing = await client.listWorkflows();
const ids: Partial<Record<keeperhub.KeeperHubWorkflowKey, string>> = {};
for (const key of keeperhub.KEEPERHUB_WORKFLOW_KEYS) {
  const def = defs[key];
  if (!def) {
    const why =
      key === "anchor"
        ? "ATTESTPAY_PAYMENT_ANCHOR_ADDRESS not set"
        : key === "notify"
          ? "no notification channel configured (KEEPERHUB_*_INTEGRATION_ID / KEEPERHUB_NOTIFY_WEBHOOK_URL)"
          : "not applicable";
    console.log(`- ${keeperhub.KEEPERHUB_WORKFLOW_NAMES[key]}: skipped (${why})`);
    continue;
  }
  const enabled = keeperhub.SCHEDULED_WORKFLOWS.has(key);
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
  console.log(`✓ ${def.name}: ${found ? "updated" : "created"} ${id}${enabled ? " (enabled, scheduled)" : ""}${validation}`);
}

const envKeys: Record<keeperhub.KeeperHubWorkflowKey, string> = {
  pay: "KEEPERHUB_WORKFLOW_PAY",
  recovery: "KEEPERHUB_WORKFLOW_RECOVERY",
  settle: "KEEPERHUB_WORKFLOW_SETTLE",
  anchor: "KEEPERHUB_WORKFLOW_ANCHOR",
  credit: "KEEPERHUB_WORKFLOW_CREDIT",
  notify: "KEEPERHUB_WORKFLOW_NOTIFY",
};

console.log("\nSet these on the API service (Render → Environment):\n");
console.log(`KEEPERHUB_WALLET_ADDRESS=${wallet}`);
for (const key of keeperhub.KEEPERHUB_WORKFLOW_KEYS) if (ids[key]) console.log(`${envKeys[key]}=${ids[key]}`);
if (generatedSecret) console.log(`KEEPERHUB_HOOK_SECRET=${hookSecret}   # generated now: set it, the workflows already carry it`);
if (defs.anchor) {
  console.log(
    `\nCross-chain proofs: payment anchors are now sent by ${wallet}. AttestPayASC.trustedAnchorer is immutable, so redeploy the ASC on Creditcoin CC3 with _trustedAnchorer=${wallet} (contracts/script, unchanged Solidity) and update ATTESTPAY_ASC_ADDRESS. Fund ${wallet} with Sepolia ETH.`,
  );
}
console.log(`\nFund ${wallet} with ETH on chain ${CHAIN_ID} for gas (or enable KeeperHub gas sponsorship).`);

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
