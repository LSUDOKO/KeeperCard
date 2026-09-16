// attestcoin-cross-chain-proof leg 1 through KeeperHub, offline.

import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, type Address, type Hex } from "viem";
import { AttestcoinError } from "../src/attestcoin/client";
import { cardIdToBytes32 } from "../src/attestcoin/config";
import type { AnchorRequest } from "../src/attestcoin/types";
import { KeeperHubAnchorer, KeeperHubClient, KeeperHubStore, anchorFunctionArgs, type KeeperHubConfig } from "../src/keeperhub";
import { Store } from "../src/store";

const ANCHOR = "0x881c55745372DfCB7dEC9B13F499b167164e2121" as Address;
const TX = `0x${"ab".repeat(32)}` as Hex;

const req: AnchorRequest = {
  chargeId: "ch_1",
  cardId: "card_1",
  payer: "0x1111111111111111111111111111111111111111",
  merchant: "0x2222222222222222222222222222222222222222",
  amountAtoms: 1_500_000n,
  sourceChainId: 8453,
  sourceTxHash: `0x${"cd".repeat(32)}` as Hex,
  paidAt: 1_780_000_000,
  memo: 'coffee "large"',
};

function config(anchorWorkflow: string | null): KeeperHubConfig {
  return {
    apiKey: "kh_test",
    apiBase: "https://kh.test/api",
    mcpUrl: "https://kh.test/mcp",
    walletAddress: null,
    workflows: { pay: null, recovery: null, settle: null, anchor: anchorWorkflow, credit: null, notify: null },
    dryRunRequired: true,
    planTtlSeconds: 600,
    gasFeeUsdc: "0.01",
    gasLimitMultiplier: "1.5",
    hookSecret: null,
  };
}

function fakeApi(opts: { runStatus: () => string; simulate?: "ok" | "revert" }) {
  const calls: Array<{ path: string; body: any; key?: string }> = [];
  let runs = 0;
  const keys = new Map<string, string>();
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/api/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const key = (init?.headers as Record<string, string> | undefined)?.["idempotency-key"];
    calls.push({ path, body, key });
    const json = (s: number, d: unknown) => new Response(JSON.stringify(d), { status: s });
    if (path === "/execute/contract-call" && body?.simulate) {
      return opts.simulate === "revert"
        ? json(400, { success: false, wouldRevert: true, failureKind: "revert", revertReason: "ZeroAmount()" })
        : json(200, { success: true, wouldRevert: false, gasEstimate: "90000", from: "0x7777777777777777777777777777777777777777" });
    }
    if (/\/workflows\/.+\/execute$/.test(path)) {
      const id = (key && keys.get(key)) ?? `run_${++runs}`;
      if (key) keys.set(key, id);
      return json(200, { executionId: id, status: "running" });
    }
    if (/\/workflows\/executions\/.+\/status$/.test(path)) {
      const st = opts.runStatus();
      return json(200, {
        status: st,
        nodeStatuses: [],
        transactionHashes: st === "success" ? [{ hash: TX, nodeId: "anchor", nodeName: "Anchor Payment", verified: true, blockNumber: 8_123_456 }] : [],
        errorContext: st === "error" ? "reverted" : null,
      });
    }
    return json(404, {});
  };
  return { calls, fetch };
}

function mk(api: ReturnType<typeof fakeApi>, workflow: string | null, extra: Partial<ConstructorParameters<typeof KeeperHubAnchorer>[0]> = {}) {
  const store = new KeeperHubStore(new Store(":memory:").db);
  let t = 0;
  const anchorer = new KeeperHubAnchorer({
    client: new KeeperHubClient(config(workflow), { fetch: api.fetch, sleep: async () => {} }),
    config: config(workflow),
    store,
    anchorAddress: ANCHOR,
    now: () => (t += 10_000),
    sleep: async () => {},
    waitMs: 30_000,
    ...extra,
  });
  return { anchorer, store };
}

describe("KeeperHub anchorer", () => {
  test("function args encode the payment exactly, memo safely quoted", () => {
    const args = JSON.parse(anchorFunctionArgs(req));
    expect(args[0]).toBe(cardIdToBytes32("card_1"));
    expect(args[3]).toBe("1500000");
    expect(args[7]).toBe('coffee "large"');
    // bytes32 round-trips as a valid ABI value
    expect(decodeAbiParameters([{ type: "bytes32" }], args[0])[0]).toBe(args[0]);
  });

  test("dry run then workflow run; verified receipt yields tx and height", async () => {
    const api = fakeApi({ runStatus: () => "success" });
    const { anchorer, store } = mk(api, "wf_anchor");
    const out = await anchorer.anchorPayment(req);
    expect(out).toEqual({ txHash: TX, height: 8_123_456 });
    expect(api.calls[0]!.body.simulate).toBe(true);
    expect(api.calls[0]!.body.chainId).toBe(11155111);
    const run = api.calls.find((c) => c.path === "/workflows/wf_anchor/execute")!;
    expect(run.key).toBe("keepercard:anchor:ch_1:0");
    expect(JSON.parse(run.body.input.functionArgs)[5]).toBe(req.sourceTxHash);
    expect(store.forCharge("ch_1").map((r) => `${r.action}:${r.status}`)).toEqual(["dry_run:simulated", "anchor:completed"]);
  });

  test("a revert in the dry run is permanent and nothing executes", async () => {
    const api = fakeApi({ runStatus: () => "success", simulate: "revert" });
    const { anchorer } = mk(api, "wf_anchor");
    const err = await anchorer.anchorPayment(req).catch((e) => e);
    expect(err).toBeInstanceOf(AttestcoinError);
    expect((err as AttestcoinError).retryable).toBe(false);
    expect(api.calls.some((c) => c.path.endsWith("/execute"))).toBe(false);
  });

  test("still running yields a retryable error; the next tick replays the same run", async () => {
    let status = "running";
    const api = fakeApi({ runStatus: () => status });
    const { anchorer } = mk(api, "wf_anchor");
    const err = await anchorer.anchorPayment(req).catch((e) => e);
    expect((err as AttestcoinError).retryable).toBe(true);
    status = "success";
    await anchorer.anchorPayment(req);
    const runs = api.calls.filter((c) => c.path.endsWith("/execute"));
    expect(runs.length).toBe(2);
    expect(runs[0]!.key).toBe(runs[1]!.key);
  });

  test("a failed run rotates the idempotency key for the retry", async () => {
    let status = "error";
    const api = fakeApi({ runStatus: () => status });
    const { anchorer } = mk(api, "wf_anchor");
    await anchorer.anchorPayment(req).catch(() => {});
    status = "success";
    await anchorer.anchorPayment(req);
    const keys = api.calls.filter((c) => c.path.endsWith("/execute")).map((c) => c.key);
    expect(keys).toEqual(["keepercard:anchor:ch_1:0", "keepercard:anchor:ch_1:1"]);
  });

  test("an existing anchor converges without touching KeeperHub", async () => {
    const api = fakeApi({ runStatus: () => "success" });
    const { anchorer } = mk(api, "wf_anchor", { existingAnchor: async () => ({ txHash: TX, height: 42 }) });
    expect(await anchorer.anchorPayment(req)).toEqual({ txHash: TX, height: 42 });
    expect(api.calls.length).toBe(0);
  });
});
