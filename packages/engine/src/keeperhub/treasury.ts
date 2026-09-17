// What KeeperCard needs to know about the world before it moves money, read through
// KeeperHub: whether its workflows exist, whether the wallets that execute payments can
// still pay for gas, and whether the dollar its budgets are written in is still a dollar.
//
// Every read here can fail, and none of them is allowed to fail a payment on its own.
// "Unknown" is reported as unknown — never as zero, never as healthy.

import type { Address } from "viem";
import type { KeeperHubClient, PriceQuote } from "./client";
import { KEEPERHUB_WORKFLOW_KEYS, KEEPERHUB_WORKFLOW_NAMES, type KeeperHubConfig, type KeeperHubWorkflowKey } from "./config";

/** Chain the Chainlink reference feeds are read on. USDC/USD exists on Base mainnet but
 * not Base Sepolia, and a read costs no gas, so testnet deployments read it too. */
export const REFERENCE_FEED_CHAIN_ID = 8453;

/**
 * Settle which KeeperHub workflow each key runs, by NAME.
 *
 * The provisioner creates workflows by name and KeeperHub keeps the id stable, so the
 * name is already the durable handle. Requiring one env var per workflow on top of that
 * only adds a way to be wrong: a deployment that forgets them silently falls back to
 * direct execution and reports every workflow as absent.
 *
 * An explicit `KEEPERHUB_WORKFLOW_<KEY>` is honoured only while it still points at a
 * workflow of the expected name. A pin that names a different workflow — or one that no
 * longer exists — is stale, and executing it would run the wrong definition (this
 * happened: a pin outlived a rename and pointed receipts at a retired contract). A stale
 * pin is dropped, loudly, in favour of the lookup.
 *
 * Mutates and returns `config`. Never throws: a KeeperHub that cannot be reached leaves
 * the config as it was, and payments fall back exactly as they did before.
 */
export async function resolveWorkflowIds(
  client: Pick<KeeperHubClient, "listWorkflows">,
  config: KeeperHubConfig,
): Promise<{ resolved: KeeperHubWorkflowKey[]; stale: Array<{ key: KeeperHubWorkflowKey; id: string; found: string | null }>; error: string | null }> {
  let workflows;
  try {
    workflows = await client.listWorkflows();
  } catch (e) {
    return { resolved: [], stale: [], error: e instanceof Error ? e.message : String(e) };
  }
  const idByName = new Map(workflows.map((w) => [w.name, w.id]));
  const nameById = new Map(workflows.map((w) => [w.id, w.name]));
  const resolved: KeeperHubWorkflowKey[] = [];
  const stale: Array<{ key: KeeperHubWorkflowKey; id: string; found: string | null }> = [];
  for (const key of KEEPERHUB_WORKFLOW_KEYS) {
    const expected = KEEPERHUB_WORKFLOW_NAMES[key];
    const pinned = config.workflows[key];
    if (pinned) {
      const actual = nameById.get(pinned) ?? null;
      if (actual === expected) continue;
      stale.push({ key, id: pinned, found: actual });
      config.workflows[key] = null;
    }
    const id = idByName.get(expected);
    if (id) {
      config.workflows[key] = id;
      resolved.push(key);
    }
  }
  return { resolved, stale, error: null };
}

export type WalletHealth = {
  address: Address;
  /** wei as a decimal string; null = the read failed, which is not the same as empty */
  gas_wei: string | null;
  /** USDC atoms as a decimal string; null = the read failed */
  usdc_atoms: string | null;
  /** true only when gas was READ and is below the floor */
  gas_low: boolean;
};

export type TreasuryReport = {
  chain_id: number;
  org_wallet: WalletHealth | null;
  sponsor_wallet: WalletHealth | null;
  usdc_usd: PriceQuoteView | null;
  eth_usd: PriceQuoteView | null;
  /** null when the feed could not be read: unknown, not "pegged" */
  usdc_depegged: boolean | null;
  depeg_floor: number | null;
};

export type PriceQuoteView = { price: number; decimals: number; updated_at: string | null; feed_chain_id: number };

const view = (q: PriceQuote | null): PriceQuoteView | null =>
  q ? { price: q.price, decimals: q.decimals, updated_at: q.updatedAt ? new Date(q.updatedAt * 1000).toISOString() : null, feed_chain_id: q.chainId } : null;

/** Below this the org wallet cannot cover a redemption when gas sponsorship falls back. */
export const GAS_LOW_WEI = 100_000_000_000_000n; // 0.0001 ETH

async function walletHealth(
  client: Pick<KeeperHubClient, "nativeBalance" | "tokenBalance">,
  address: Address,
  usdc: Address,
  chainId: number,
): Promise<WalletHealth> {
  const [gas, token] = await Promise.all([
    client.nativeBalance(address, chainId).catch(() => null),
    client.tokenBalance(address, usdc, chainId).catch(() => null),
  ]);
  return {
    address,
    gas_wei: gas === null ? null : gas.toString(),
    usdc_atoms: token === null ? null : token.atoms.toString(),
    gas_low: gas !== null && gas < GAS_LOW_WEI,
  };
}

/** Live treasury state, every figure read through KeeperHub. */
export async function readTreasury(opts: {
  client: Pick<KeeperHubClient, "nativeBalance" | "tokenBalance" | "priceFeed">;
  chainId: number;
  usdc: Address;
  orgWallet: Address | null;
  sponsorWallet?: Address | null;
  depegFloor: number | null;
  feedChainId?: number;
}): Promise<TreasuryReport> {
  const feedChain = opts.feedChainId ?? REFERENCE_FEED_CHAIN_ID;
  const [org, sponsor, usdcUsd, ethUsd] = await Promise.all([
    opts.orgWallet ? walletHealth(opts.client, opts.orgWallet, opts.usdc, opts.chainId) : Promise.resolve(null),
    opts.sponsorWallet ? walletHealth(opts.client, opts.sponsorWallet, opts.usdc, opts.chainId) : Promise.resolve(null),
    opts.client.priceFeed("usdc-usd", feedChain).catch(() => null),
    opts.client.priceFeed("eth-usd", feedChain).catch(() => null),
  ]);
  return {
    chain_id: opts.chainId,
    org_wallet: org,
    sponsor_wallet: sponsor,
    usdc_usd: view(usdcUsd),
    eth_usd: view(ethUsd),
    usdc_depegged: usdcUsd === null || opts.depegFloor === null ? null : usdcUsd.price < opts.depegFloor,
    depeg_floor: opts.depegFloor,
  };
}

/**
 * The depeg guard the payment dry run consults, with a short cache so a burst of
 * payments does not turn into a burst of oracle reads.
 *
 * Returns a refusal reason only on a verdict the feed actually reached. A feed that
 * cannot be read yields `null` — cards are not frozen because an oracle blinked.
 */
export class DepegGuard {
  private cached: { at: number; quote: PriceQuote | null } | null = null;

  constructor(
    private readonly client: Pick<KeeperHubClient, "priceFeed">,
    private readonly floor: number | null,
    private readonly opts: { ttlMs?: number; feedChainId?: number; now?: () => number } = {},
  ) {}

  async quote(): Promise<PriceQuote | null> {
    const now = (this.opts.now ?? Date.now)();
    if (this.cached && now - this.cached.at < (this.opts.ttlMs ?? 60_000)) return this.cached.quote;
    const quote = await this.client.priceFeed("usdc-usd", this.opts.feedChainId ?? REFERENCE_FEED_CHAIN_ID).catch(() => null);
    this.cached = { at: now, quote };
    return quote;
  }

  /** A refusal reason when USDC is verifiably below the floor; null otherwise. */
  async refusal(): Promise<string | null> {
    if (this.floor === null) return null;
    const q = await this.quote();
    if (!q || q.price >= this.floor) return null;
    return `usdc_depegged: Chainlink USDC/USD reads ${q.price.toFixed(4)}, below the ${this.floor} floor; this card's budget is written in a dollar that is not currently worth one`;
  }
}
