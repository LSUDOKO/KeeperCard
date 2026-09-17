// Treasury reads, workflow resolution and the depeg guard. The rule under test in almost
// every case is the same: a read that FAILED is "unknown", and unknown must never be
// reported as zero, as healthy, or as a reason to refuse a payment.

import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import {
  DepegGuard,
  GAS_LOW_WEI,
  KEEPERHUB_WORKFLOW_KEYS,
  KEEPERHUB_WORKFLOW_NAMES,
  readTreasury,
  resolveWorkflowIds,
  type KeeperHubConfig,
  type PriceQuote,
} from "../src/keeperhub";

const WALLET = "0x4F719186a5545B8dB9a8e3e2F31eDdfc55BaD441" as Address;
const SPONSOR = "0x66b6082Eb6c7a9457F25479fa35b6061F2c4EC5a" as Address;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;

function config(over: Partial<KeeperHubConfig["workflows"]> = {}): KeeperHubConfig {
  return {
    apiKey: "kh_test",
    apiBase: "https://kh.test/api",
    mcpUrl: "https://kh.test/mcp",
    walletAddress: WALLET,
    workflows: { ...(Object.fromEntries(KEEPERHUB_WORKFLOW_KEYS.map((k) => [k, null])) as KeeperHubConfig["workflows"]), ...over },
    dryRunRequired: true,
    planTtlSeconds: 600,
    gasFeeUsdc: "0.01",
    gasLimitMultiplier: "1.5",
    hookSecret: null,
    receiptAnchorAddress: null,
    guardedMinUsdc: null,
    depegFloor: 0.98,
  };
}

const quote = (price: number): PriceQuote => ({
  pair: "usdc-usd",
  raw: BigInt(Math.round(price * 1e6)) * 10n ** 12n,
  decimals: 18,
  price,
  updatedAt: 1_789_590_071,
  chainId: 8453,
});

describe("resolveWorkflowIds", () => {
  const live = [
    { id: "wf_pay", name: KEEPERHUB_WORKFLOW_NAMES.pay },
    { id: "wf_market", name: KEEPERHUB_WORKFLOW_NAMES.market },
    { id: "wf_other", name: "Aave Health Factor Monitor" },
  ];

  test("fills in missing ids by workflow name, so a deployment needs no per-workflow env vars", async () => {
    const cfg = config();
    const r = await resolveWorkflowIds({ listWorkflows: async () => live as never }, cfg);
    expect(r.error).toBeNull();
    expect(r.resolved.sort()).toEqual(["market", "pay"]);
    expect(cfg.workflows.pay).toBe("wf_pay");
    expect(cfg.workflows.market).toBe("wf_market");
    // a workflow that does not exist stays unset rather than being guessed
    expect(cfg.workflows.guarded).toBeNull();
  });

  test("an explicitly configured id wins over the name lookup", async () => {
    const cfg = config({ pay: "wf_pinned" });
    await resolveWorkflowIds({ listWorkflows: async () => live as never }, cfg);
    expect(cfg.workflows.pay).toBe("wf_pinned");
  });

  test("an unreachable KeeperHub leaves the config untouched and reports why, without throwing", async () => {
    const cfg = config({ pay: "wf_pinned" });
    const r = await resolveWorkflowIds(
      {
        listWorkflows: async () => {
          throw new Error("kh unreachable");
        },
      },
      cfg,
    );
    expect(r.error).toBe("kh unreachable");
    expect(r.resolved).toEqual([]);
    expect(cfg.workflows.pay).toBe("wf_pinned");
  });

  test("nothing missing means no call at all", async () => {
    const all = Object.fromEntries(KEEPERHUB_WORKFLOW_KEYS.map((k) => [k, `wf_${k}`])) as KeeperHubConfig["workflows"];
    let called = false;
    await resolveWorkflowIds(
      {
        listWorkflows: async () => {
          called = true;
          return [];
        },
      },
      config(all),
    );
    expect(called).toBe(false);
  });
});

describe("DepegGuard", () => {
  test("refuses only on a verdict the feed actually reached", async () => {
    const pegged = new DepegGuard({ priceFeed: async () => quote(0.9998) }, 0.98);
    expect(await pegged.refusal()).toBeNull();

    const depegged = new DepegGuard({ priceFeed: async () => quote(0.91) }, 0.98);
    const reason = await depegged.refusal();
    expect(reason).toMatch(/^usdc_depegged:/);
    expect(reason).toContain("0.9100");
  });

  test("a feed that cannot be read refuses nothing: cards are not frozen because an oracle blinked", async () => {
    const down = new DepegGuard({ priceFeed: async () => null }, 0.98);
    expect(await down.refusal()).toBeNull();
    const throwing = new DepegGuard(
      {
        priceFeed: async () => {
          throw new Error("rpc down");
        },
      },
      0.98,
    );
    expect(await throwing.refusal()).toBeNull();
  });

  test("a null floor disables the guard without reading the feed", async () => {
    let reads = 0;
    const off = new DepegGuard(
      {
        priceFeed: async () => {
          reads++;
          return quote(0.5);
        },
      },
      null,
    );
    expect(await off.refusal()).toBeNull();
    expect(reads).toBe(0);
  });

  test("a burst of payments shares one oracle read", async () => {
    let reads = 0;
    let now = 1_000_000;
    const guard = new DepegGuard(
      {
        priceFeed: async () => {
          reads++;
          return quote(1);
        },
      },
      0.98,
      { ttlMs: 60_000, now: () => now },
    );
    await guard.refusal();
    await guard.refusal();
    await guard.refusal();
    expect(reads).toBe(1);
    now += 61_000;
    await guard.refusal();
    expect(reads).toBe(2);
  });
});

describe("readTreasury", () => {
  test("reports balances, prices and a low-gas flag from live reads", async () => {
    const t = await readTreasury({
      client: {
        nativeBalance: async (a) => (a === WALLET ? GAS_LOW_WEI - 1n : 5n * GAS_LOW_WEI),
        tokenBalance: async () => ({ atoms: 18_021_016n, decimals: 6, symbol: "USDC" }),
        priceFeed: async (pair) => (pair === "usdc-usd" ? quote(0.9999) : { ...quote(2456.31), pair: "eth-usd", decimals: 8 }),
      },
      chainId: 84532,
      usdc: USDC,
      orgWallet: WALLET,
      sponsorWallet: SPONSOR,
      depegFloor: 0.98,
    });
    expect(t.org_wallet!.gas_low).toBe(true);
    expect(t.sponsor_wallet!.gas_low).toBe(false);
    expect(t.org_wallet!.usdc_atoms).toBe("18021016");
    expect(t.usdc_depegged).toBe(false);
    expect(t.eth_usd!.price).toBeCloseTo(2456.31, 2);
  });

  test("a failed read is null — never zero, never 'low', never 'pegged'", async () => {
    const t = await readTreasury({
      client: {
        nativeBalance: async () => null,
        tokenBalance: async () => {
          throw new Error("rpc down");
        },
        priceFeed: async () => null,
      },
      chainId: 84532,
      usdc: USDC,
      orgWallet: WALLET,
      depegFloor: 0.98,
    });
    expect(t.org_wallet!.gas_wei).toBeNull();
    expect(t.org_wallet!.usdc_atoms).toBeNull();
    // an unreadable balance must not raise a low-gas alarm...
    expect(t.org_wallet!.gas_low).toBe(false);
    // ...and an unreadable feed is "unknown", not "fine"
    expect(t.usdc_depegged).toBeNull();
    expect(t.sponsor_wallet).toBeNull();
  });
});
