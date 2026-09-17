// Checks a KeeperHub integration end to end without moving value.
//
//   bun run keeperhub:doctor
//
// 1. API key authenticates and resolves the org wallet
// 2. settlement chain enabled in KeeperHub
// 3. org wallet has gas on those chains
// 4. every configured KEEPERHUB_WORKFLOW_* exists, validates, and is enabled where scheduled
// 5. KeeperHub's simulator answers (dry run of a read-only USDC call from the wallet)
// 6. the public hook endpoint is reachable with the shared secret
// 7. spend cap headroom

import { createPublicClient, erc20Abi, formatEther, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { CHAIN_ID, CHAINS, keeperhub } from "@attestpay/engine";

let failures = 0;
const ok = (m: string) => console.log(`✓ ${m}`);
const warn = (m: string) => console.log(`! ${m}`);
const bad = (m: string) => {
  failures++;
  console.log(`✗ ${m}`);
};

const config = keeperhub.keeperhubConfig();
if (!config) {
  bad(`KeeperHub not configured: ${keeperhub.keeperhubDisabledReason()}`);
  process.exit(1);
}
const client = new keeperhub.KeeperHubClient(config);

let wallet: Address | null = config.walletAddress;
try {
  const resolved = await client.walletAddress();
  if (!resolved) bad("API key works but the organization has no web3 wallet");
  else {
    if (wallet && wallet.toLowerCase() !== resolved.toLowerCase()) bad(`KEEPERHUB_WALLET_ADDRESS=${wallet} but KeeperHub's org wallet is ${resolved}`);
    wallet = resolved;
    ok(`API key authenticates · org wallet ${wallet}`);
  }
} catch (e) {
  bad(`API key rejected: ${e instanceof Error ? e.message : String(e)}`);
}

const chains = await client.listChains().catch(() => []);
// receipts are anchored on the settlement chain itself, so there is only one to check
const need = [CHAIN_ID as number];
for (const id of need) {
  const c = chains.find((x) => x.chainId === id);
  if (c?.isEnabled) ok(`chain ${id} ${c.name} enabled${c.usePrivateMempoolRpc ? " · private mempool" : ""}`);
  else bad(`chain ${id} not enabled in KeeperHub`);
}

if (wallet) {
  const viemChains: Record<number, Parameters<typeof createPublicClient>[0]["chain"]> = { 8453: base, 84532: baseSepolia };
  for (const id of need) {
    try {
      const pc = createPublicClient({ chain: viemChains[id], transport: http(id === CHAIN_ID ? process.env.ATTESTPAY_RPC_URL : undefined) });
      const bal = await pc.getBalance({ address: wallet });
      if (bal === 0n) warn(`wallet has 0 ETH on chain ${id} (fine only with KeeperHub gas sponsorship)`);
      else ok(`wallet gas on chain ${id}: ${formatEther(bal)} ETH`);
    } catch (e) {
      warn(`could not read wallet balance on chain ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Workflow ids are resolved by name, exactly as the server does at boot, so the doctor
// reports what a deployment with no KEEPERHUB_WORKFLOW_* vars will actually run.
const resolution = await keeperhub.resolveWorkflowIds(client, config);
if (resolution.error) warn(`could not look up workflows by name: ${resolution.error}`);
for (const s of resolution.stale) {
  bad(`${keeperhub.workflowEnvVar(s.key)}=${s.id} is stale (${s.found ? `that id is now "${s.found}"` : "no such workflow"}): remove it; the server ignores it and resolves by name`);
}
if (resolution.resolved.length) ok(`${resolution.resolved.length} workflow(s) resolved by name: no workflow env vars needed`);

// recovery and sweep are nothing but a schedule calling back into KeeperCard, so on a
// plan without the `HTTP Request` action they cannot exist and KeeperCard keeps its own
// timers. Absent is then correct, not a fault.
const features = await client.features().catch(() => null);
const hooksEnabled = features?.usableFeatureIds.has(keeperhub.HTTP_REQUEST_FEATURE_ID) ?? true;
if (features) {
  (hooksEnabled ? ok : warn)(
    hooksEnabled
      ? `plan ${features.plan} · HTTP Request available, workflows call back`
      : `plan ${features.plan} · HTTP Request is Pro-gated, KeeperCard polls instead`,
  );
}

for (const key of keeperhub.KEEPERHUB_WORKFLOW_KEYS) {
  const id = config.workflows[key];
  const name = keeperhub.KEEPERHUB_WORKFLOW_NAMES[key];
  const hookOnly = key === "recovery" || key === "sweep";
  if (!id) {
    if (hookOnly && !hooksEnabled) ok(`${name}: not on KeeperHub (needs Pro's HTTP Request) · KeeperCard runs its own timer`);
    else if (key === "notify") warn(`${name}: not provisioned (no notification integration configured)`);
    else if ((key === "anchor" || key === "receipts") && !config.receiptAnchorAddress) warn(`${name}: not provisioned (KEEPERHUB_RECEIPT_ANCHOR_ADDRESS unset)`);
    else (key === "pay" ? bad : warn)(`${name}: not found on KeeperHub (run keeperhub:provision)`);
    continue;
  }
  try {
    const wf = await client.getWorkflow(id);
    const v = await client.validateWorkflow(id).catch(() => null);
    const autonomous = keeperhub.AUTONOMOUS_WORKFLOWS.has(key);
    const trig = keeperhub.KEEPERHUB_WORKFLOW_TRIGGERS[key];
    if (autonomous && wf.enabled === false) bad(`${name} (${id}) is DISABLED: its ${trig} trigger will never fire`);
    else ok(`${name} (${id}) · ${trig}${v ? " · validated" : ""}${wf.enabled === false ? " · disabled" : " · enabled"}`);
  } catch (e) {
    bad(`${name} (${id}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// what the dry run's depeg guard will see
const usdcUsd = await client.priceFeed("usdc-usd", keeperhub.REFERENCE_FEED_CHAIN_ID).catch(() => null);
if (!usdcUsd) warn("Chainlink USDC/USD could not be read through KeeperHub: the depeg guard will refuse nothing until it can");
else if (config.depegFloor !== null && usdcUsd.price < config.depegFloor) bad(`USDC/USD reads ${usdcUsd.price.toFixed(4)}, below the ${config.depegFloor} floor: payments are being refused`);
else ok(`Chainlink USDC/USD ${usdcUsd.price.toFixed(4)} · depeg floor ${config.depegFloor ?? "off"}`);

if (config.receiptAnchorAddress) ok(`on-chain receipts → PaymentAnchor ${config.receiptAnchorAddress} on chain ${CHAIN_ID}`);
else warn("KEEPERHUB_RECEIPT_ANCHOR_ADDRESS unset: payments will carry no on-chain receipt");

if (wallet) {
  try {
    const sim = await client.simulateContractCall({
      contractAddress: CHAINS[CHAIN_ID].usdc,
      chainId: CHAIN_ID,
      functionName: "balanceOf",
      functionArgs: JSON.stringify([wallet]),
      abi: JSON.stringify(erc20Abi),
    });
    if (sim.success || sim.wouldRevert === false) ok(`KeeperHub simulator answers on chain ${CHAIN_ID}`);
    else warn(`simulator reply: ${sim.error ?? sim.revertReason ?? JSON.stringify(sim.raw).slice(0, 160)}`);
  } catch (e) {
    warn(`simulator check could not run: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const publicBase = process.env.ATTESTPAY_PUBLIC_MCP_BASE;
if (!hooksEnabled) {
  ok("no workflow calls back on this plan: hook endpoint not exercised");
} else if (publicBase && config.hookSecret) {
  try {
    const res = await fetch(`${publicBase.replace(/\/+$/, "")}/api/keeperhub/hooks/settle`, {
      method: "POST",
      headers: { [keeperhub.HOOK_SECRET_HEADER]: config.hookSecret },
      signal: AbortSignal.timeout(45_000),
    });
    if (res.ok) ok(`hook endpoint reachable at ${publicBase}`);
    else bad(`hook endpoint answered ${res.status} (secret mismatch or old deploy?)`);
  } catch (e) {
    bad(`hook endpoint unreachable at ${publicBase}: ${e instanceof Error ? e.message : String(e)}`);
  }
} else {
  warn("ATTESTPAY_PUBLIC_MCP_BASE or KEEPERHUB_HOOK_SECRET unset: skipping hook reachability");
}

try {
  const cap = await client.spendCap();
  ok(`spend cap: ${JSON.stringify(cap).slice(0, 200)}`);
} catch {
  warn("spend cap unavailable");
}

console.log(failures ? `\n${failures} problem(s)` : "\nKeeperHub integration healthy");
process.exit(failures ? 1 : 0);
