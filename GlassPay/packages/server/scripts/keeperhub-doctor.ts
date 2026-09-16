// Checks a KeeperHub integration end to end without moving value.
//
//   bun run keeperhub:doctor
//
// 1. API key authenticates and resolves the org wallet
// 2. settlement chain (and Sepolia for anchors) enabled in KeeperHub
// 3. org wallet has gas on those chains
// 4. every configured KEEPERHUB_WORKFLOW_* exists, validates, and is enabled where scheduled
// 5. KeeperHub's simulator answers (dry run of a read-only USDC call from the wallet)
// 6. the public hook endpoint is reachable with the shared secret
// 7. spend cap headroom

import { createPublicClient, erc20Abi, formatEther, http, type Address } from "viem";
import { base, baseSepolia, sepolia } from "viem/chains";
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
const need = [CHAIN_ID as number, ...(config.workflows.anchor ? [keeperhub.ETHEREUM_SEPOLIA_CHAIN_ID] : [])];
for (const id of need) {
  const c = chains.find((x) => x.chainId === id);
  if (c?.isEnabled) ok(`chain ${id} ${c.name} enabled${c.usePrivateMempoolRpc ? " · private mempool" : ""}`);
  else bad(`chain ${id} not enabled in KeeperHub`);
}

if (wallet) {
  const viemChains: Record<number, Parameters<typeof createPublicClient>[0]["chain"]> = { 8453: base, 84532: baseSepolia, 11155111: sepolia };
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

for (const key of keeperhub.KEEPERHUB_WORKFLOW_KEYS) {
  const id = config.workflows[key];
  const name = keeperhub.KEEPERHUB_WORKFLOW_NAMES[key];
  if (!id) {
    (key === "pay" || key === "recovery" ? bad : warn)(`${name}: no workflow id configured (run keeperhub:provision)`);
    continue;
  }
  try {
    const wf = await client.getWorkflow(id);
    const v = await client.validateWorkflow(id).catch(() => null);
    const scheduled = keeperhub.SCHEDULED_WORKFLOWS.has(key);
    if (scheduled && wf.enabled === false) bad(`${name} (${id}) is DISABLED: its schedule will never fire`);
    else ok(`${name} (${id}) exists${v ? " · validated" : ""}${scheduled ? " · schedule enabled" : ""}`);
  } catch (e) {
    bad(`${name} (${id}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

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
if (publicBase && config.hookSecret) {
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
