// KeeperHub execution layer, offline. A fake KeeperHub HTTP API (shaped after
// KeeperHub's own route code) drives the REAL client, executor, store and spend()
// pipeline: dry run -> reviewed plan -> exact execution -> verified status.

import { beforeAll, describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAINS, DELEGATION_MANAGER } from "../src/chains";
import { EngineError } from "../src/errors";
import { issueRootCard } from "../src/issuance";
import {
  KeeperHubClient,
  KeeperHubError,
  KeeperHubExecutor,
  KeeperHubStore,
  REDEEM_DELEGATIONS_ABI,
  EXECUTION_MODE_BATCH,
  EXECUTION_MODE_SINGLE,
  buildWorkflowDefinitions,
  encodePlanContext,
  encodeRedemption,
  executorMode,
  keeperhubConfig,
  keeperhubDisabledReason,
  parseKeeperHubRequestId,
  parsePlanContext,
  attestAnchors,
  workflowKeyFor,
  type KeeperHubConfig,
} from "../src/keeperhub";
import { planSpend, reconcileKeeperHub, spend, type SpendDeps } from "../src/spend";
import { Store } from "../src/store";
import type { RelayerTransaction } from "../src/relayer";

const NOW = 1_780_000_000;
const WALLET = "0x7777777777777777777777777777777777777777" as Address;
const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127" as Address;
const TX = "0x5f2c9d1e0a4b3c6d7e8f90112233445566778899aabbccddeeff001122334455" as Hex;
const user = privateKeyToAccount(generatePrivateKey());

beforeAll(() => {
  process.env.ATTESTPAY_MASTER_KEY = "d".repeat(64);
});

// ---------------------------------------------------------------------------
// Fake KeeperHub API
// ---------------------------------------------------------------------------

type Call = { method: string; path: string; body: any; headers: Record<string, string> };

class FakeKeeperHub {
  calls: Call[] = [];
  simulateMode: "ok" | "revert" | "unfunded" = "ok";
  workflowStatus: "running" | "success" | "error" = "success";
  directStatus: "completed" | "failed" | "unconfirmed" = "completed";
  failNext: Array<number> = [];
  private idem = new Map<string, unknown>();
  private runs = 0;

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, "") + u.search;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const method = init?.method ?? "GET";
    this.calls.push({ method, path, body, headers });
    const json = (status: number, data: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });

    const forced = this.failNext.shift();
    if (forced) return json(forced, { error: `forced ${forced}` });

    if (path.startsWith("/integrations")) return json(200, [{ id: "int_1", name: "Org Wallet", type: "web3", address: WALLET }]);

    if (path === "/execute/contract-call" && method === "POST") {
      if (body.simulate === true) {
        if (this.simulateMode === "revert") {
          return json(400, { success: false, status: "simulated", failureKind: "revert", wouldRevert: true, revertReason: "ERC20PeriodTransferEnforcer:transfer-amount-exceeded", error: "execution reverted" });
        }
        if (this.simulateMode === "unfunded") {
          return json(400, { success: false, code: "insufficient_balance", error: "Insufficient ETH balance", from: WALLET });
        }
        return json(200, { success: true, status: "simulated", from: WALLET, to: body.contractAddress, value: "0", gasEstimate: "184223", wouldRevert: false });
      }
      const key = headers["idempotency-key"];
      if (key && this.idem.has(key)) return json(202, { ...(this.idem.get(key) as object), idempotentReplay: true });
      const res = { executionId: `dx_${++this.runs}`, status: "completed", transactionHash: TX, transactionLink: `https://basescan.org/tx/${TX}` };
      if (key) this.idem.set(key, res);
      return json(202, res);
    }

    const exec = /^\/workflows\/([^/]+)\/execute$/.exec(path);
    if (exec && method === "POST") {
      const key = headers["idempotency-key"];
      if (key && this.idem.has(key)) return json(200, { ...(this.idem.get(key) as object), idempotentReplay: true });
      const res = { executionId: `run_${++this.runs}`, status: "running" };
      if (key) this.idem.set(key, res);
      return json(200, res);
    }

    if (/^\/workflows\/executions\/[^/]+\/status$/.test(path)) {
      const done = this.workflowStatus !== "running";
      return json(
        200,
        {
          status: this.workflowStatus,
          nodeStatuses: [{ nodeId: "redeem", status: this.workflowStatus === "error" ? "error" : "success" }],
          progress: { totalSteps: 3, completedSteps: done ? 3 : 1, runningSteps: 0, percentage: done ? 100 : 33 },
          errorContext: this.workflowStatus === "error" ? "execution reverted" : null,
          transactionHashes: this.workflowStatus === "running" ? [] : [{ hash: TX, nodeId: "redeem", nodeName: "Redeem Delegations", verified: true, receiptStatus: this.workflowStatus === "error" ? "reverted" : "success", blockNumber: 123 }],
        },
        { "x-poll-interval-hint": done ? "0" : "2" },
      );
    }

    if (/^\/execute\/[^/]+\/status$/.test(path)) {
      return json(200, {
        executionId: path.split("/")[2],
        status: this.directStatus,
        type: "contract-call",
        network: "base",
        transactionHash: TX,
        transactionLink: `https://basescan.org/tx/${TX}`,
        sponsored: false,
        retryCount: 1,
        receipts: this.directStatus === "completed" ? [{ hash: TX, chainId: 8453, verified: true, receiptStatus: "success", blockNumber: 99, gasUsed: "150000" }] : [],
        gasUsedWei: "1500000000000",
        estimatedCostUsd: "0.004",
        error: this.directStatus === "failed" ? "reverted" : null,
      });
    }

    if (path.startsWith("/workflows?")) return json(200, []);
    return json(404, { error: `no fake route for ${method} ${path}` });
  };
}

function cfg(over: Partial<KeeperHubConfig> = {}): KeeperHubConfig {
  return {
    apiKey: "kh_test",
    apiBase: "https://kh.test/api",
    mcpUrl: "https://kh.test/mcp",
    walletAddress: null,
    workflows: { pay: null, recovery: null, settle: null, anchor: null, credit: null, notify: null },
    dryRunRequired: true,
    planTtlSeconds: 600,
    gasFeeUsdc: "0.01",
    gasLimitMultiplier: "1.5",
    hookSecret: null,
    ...over,
  };
}

function mkExecutor(api: FakeKeeperHub, over: Partial<KeeperHubConfig> = {}, store: KeeperHubStore | null = null) {
  const config = cfg(over);
  const client = new KeeperHubClient(config, { fetch: api.fetch, sleep: async () => {}, backoffMs: 1 });
  return new KeeperHubExecutor({ config, client, store, chainId: 8453, now: () => (NOW + 60) * 1000, sleep: async () => {} });
}

async function mkWorld(api: FakeKeeperHub, over: Partial<KeeperHubConfig> = {}) {
  const store = new Store(":memory:");
  store.upsertUser({ id: "u1", address: user.address });
  const plans = new KeeperHubStore(store.db);
  const executor = mkExecutor(api, over, plans);
  const deps: SpendDeps = {
    store,
    relayer: executor,
    plans,
    now: () => NOW + 60,
    codeCheck: async () => true,
    feeJitter: (b) => b,
  };
  const card = await issueRootCard(
    { store, userSigner: user, now: () => NOW, revocationNonceOverride: 0n },
    { userId: "u1", name: "kh card", terms: { pay: { period: { amount: "25", seconds: 604800 } }, expiry: NOW + 30 * 86400 } },
  );
  return { store, plans, executor, deps, cardId: card.cardId };
}

function sampleTransactions(n = 1): RelayerTransaction[] {
  const executions = Array.from({ length: n }, (_, i) => ({
    target: CHAINS[8453].usdc,
    value: "0",
    data: `0xa9059cbb000000000000000000000000${MERCHANT.slice(2).toLowerCase()}${(1000 + i).toString(16).padStart(64, "0")}` as Hex,
  }));
  return [
    {
      permissionContext: [
        { delegate: WALLET, delegator: user.address, authority: `0x${"ff".repeat(32)}` as Hex, caveats: [], salt: "0x01" as Hex, signature: "0x1234" as Hex },
      ],
      executions,
    },
  ];
}

// ---------------------------------------------------------------------------

describe("keeperhub config", () => {
  test("executor defaults to keeperhub; 1shot only when explicitly chosen", () => {
    expect(executorMode({})).toBe("keeperhub");
    expect(executorMode({ ATTESTPAY_EXECUTOR: "1shot" })).toBe("1shot");
    expect(() => executorMode({ ATTESTPAY_EXECUTOR: "relayerx" })).toThrow();
  });

  test("unset key disables KeeperHub and says why", () => {
    expect(keeperhubConfig({})).toBeNull();
    expect(keeperhubDisabledReason({})).toContain("KEEPERHUB_API_KEY");
    expect(keeperhubConfig({ KEEPERHUB_API_KEY: "  " })).toBeNull();
  });

  test("defaults: dry run required, public API base, 10 minute plans", () => {
    const c = keeperhubConfig({ KEEPERHUB_API_KEY: "kh_x", KEEPERHUB_WORKFLOW_PAY: "wf_pay" })!;
    expect(c.dryRunRequired).toBe(true);
    expect(c.apiBase).toBe("https://app.keeperhub.com/api");
    expect(c.planTtlSeconds).toBe(600);
    expect(c.workflows.pay).toBe("wf_pay");
    expect(c.workflows.anchor).toBeNull();
    expect(keeperhubConfig({ KEEPERHUB_API_KEY: "kh_x", KEEPERHUB_DRY_RUN_REQUIRED: "0" })!.dryRunRequired).toBe(false);
    expect(() => keeperhubConfig({ KEEPERHUB_API_KEY: "kh_x", KEEPERHUB_GAS_FEE_USDC: "abc" })).toThrow();
  });
});

describe("keeperhub client", () => {
  test("bearer auth, bare-array integrations, wallet resolution", async () => {
    const api = new FakeKeeperHub();
    const client = new KeeperHubClient(cfg(), { fetch: api.fetch, sleep: async () => {} });
    expect(await client.walletAddress()).toBe(WALLET);
    expect(api.calls[0]!.headers.authorization).toBe("Bearer kh_test");
    expect(api.calls[0]!.path).toBe("/integrations?type=web3");
  });

  test("reads retry transient failures with backoff", async () => {
    const api = new FakeKeeperHub();
    api.failNext = [503, 429];
    const client = new KeeperHubClient(cfg(), { fetch: api.fetch, sleep: async () => {}, backoffMs: 1 });
    expect(await client.walletAddress()).toBe(WALLET);
    expect(api.calls.length).toBe(3);
  });

  test("a write without an idempotency key is never retried", async () => {
    const api = new FakeKeeperHub();
    api.failNext = [503];
    const client = new KeeperHubClient(cfg(), { fetch: api.fetch, sleep: async () => {}, backoffMs: 1 });
    await expect(client.executeWorkflow("wf", {})).rejects.toBeInstanceOf(KeeperHubError);
    expect(api.calls.length).toBe(1);
  });

  test("a keyed write retries and a replay returns the same execution", async () => {
    const api = new FakeKeeperHub();
    api.failNext = [502];
    const client = new KeeperHubClient(cfg(), { fetch: api.fetch, sleep: async () => {}, backoffMs: 1 });
    const a = await client.executeWorkflow("wf", { x: 1 }, "k1");
    const b = await client.executeWorkflow("wf", { x: 1 }, "k1");
    expect(a.executionId).toBe(b.executionId);
    expect(b.idempotentReplay).toBe(true);
    expect(api.calls.length).toBe(3);
  });

  test("simulated revert is an answer, not a transport error", async () => {
    const api = new FakeKeeperHub();
    api.simulateMode = "revert";
    const client = new KeeperHubClient(cfg(), { fetch: api.fetch });
    const sim = await client.simulateContractCall({ contractAddress: DELEGATION_MANAGER, chainId: 8453, data: "0x01" });
    expect(sim.success).toBe(false);
    expect(sim.wouldRevert).toBe(true);
    expect(sim.revertReason).toContain("transfer-amount-exceeded");
  });
});

describe("redemption calldata", () => {
  test("encodes redeemDelegations with matching modes and a stable digest", () => {
    const one = encodeRedemption(sampleTransactions(1));
    const again = encodeRedemption(sampleTransactions(1));
    expect(one.digest).toBe(again.digest);
    const decoded = decodeFunctionData({ abi: REDEEM_DELEGATIONS_ABI, data: one.data });
    expect(decoded.functionName).toBe("redeemDelegations");
    expect(decoded.args[1]).toEqual([EXECUTION_MODE_SINGLE]);
    expect(JSON.parse(one.functionArgs)).toEqual(one.args);

    const batch = encodeRedemption(sampleTransactions(2));
    expect(decodeFunctionData({ abi: REDEEM_DELEGATIONS_ABI, data: batch.data }).args[1]).toEqual([EXECUTION_MODE_BATCH]);
    expect(batch.digest).not.toBe(one.digest);
    expect(batch.executionCount).toBe(2);
  });

  test("plan context and request id round-trip", () => {
    const ctx = encodePlanContext({ digest: `0x${"ab".repeat(32)}`, simulatedAt: NOW, gasEstimate: "21000" });
    expect(parsePlanContext(ctx)).toEqual({ digest: `0x${"ab".repeat(32)}`, simulatedAt: NOW, gasEstimate: "21000" });
    expect(parsePlanContext("ctx-ok")).toBeNull();
    expect(parseKeeperHubRequestId("kh:wf:run_9")).toEqual({ surface: "workflow", executionId: "run_9" });
    expect(parseKeeperHubRequestId("0xrequestid")).toBeNull();
  });
});

describe("KeeperHubExecutor", () => {
  test("delegate and fee collector are the KeeperHub org wallet", async () => {
    const ex = mkExecutor(new FakeKeeperHub());
    expect(await ex.delegateAddress()).toBe(WALLET);
    const fee = await ex.getFeeData(CHAINS[8453].usdc);
    expect(fee.feeCollector).toBe(WALLET);
    expect(fee.minFee).toBe("0.01");
  });

  test("dry run simulates the exact calldata from the wallet and returns a plan token", async () => {
    const api = new FakeKeeperHub();
    const ex = mkExecutor(api);
    const txs = sampleTransactions();
    const est = await ex.estimate(txs);
    expect(est.success).toBe(true);
    const sim = api.calls.find((c) => c.body?.simulate === true)!;
    expect(sim.body.contractAddress).toBe(DELEGATION_MANAGER);
    expect(sim.body.data).toBe(encodeRedemption(txs).data);
    expect(parsePlanContext(est.context)!.digest).toBe(encodeRedemption(txs).digest);
  });

  test("simulated revert surfaces the enforcer reason; unfunded wallet is an engine error", async () => {
    const api = new FakeKeeperHub();
    api.simulateMode = "revert";
    const est = await mkExecutor(api).estimate(sampleTransactions());
    expect(est.success).toBe(false);
    expect(est.error).toContain("transfer-amount-exceeded");

    api.simulateMode = "unfunded";
    await expect(mkExecutor(api).estimate(sampleTransactions())).rejects.toBeInstanceOf(EngineError);
  });

  test("refuses to execute bytes that were not dry-run", async () => {
    const api = new FakeKeeperHub();
    const ex = mkExecutor(api);
    const est = await ex.estimate(sampleTransactions(1));
    // different bytes than the reviewed plan
    await expect(ex.send(sampleTransactions(2), est.context!)).rejects.toThrow(/not dry-run|differ/);
    await expect(ex.send(sampleTransactions(1), "ctx-ok")).rejects.toThrow(/dry-run/);
    expect(api.calls.some((c) => c.path === "/execute/contract-call" && c.body?.simulate !== true)).toBe(false);
  });

  test("refuses an expired plan", async () => {
    const api = new FakeKeeperHub();
    const ex = mkExecutor(api);
    const txs = sampleTransactions();
    const stale = encodePlanContext({ digest: encodeRedemption(txs).digest, simulatedAt: NOW - 3600, gasEstimate: null });
    await expect(ex.send(txs, stale)).rejects.toThrow(/expired/);
  });

  test("executes through the pay workflow with the reviewed functionArgs and a digest idempotency key", async () => {
    const api = new FakeKeeperHub();
    const ex = mkExecutor(api, { workflows: { pay: "wf_pay", recovery: null, settle: null, anchor: null, credit: "wf_credit", notify: null } });
    const txs = sampleTransactions();
    const est = await ex.estimate(txs);
    const id = await ex.send(txs, est.context!, undefined, { purpose: "pay", cardId: "c1", chargeId: "ch1" });
    expect(parseKeeperHubRequestId(id)!.surface).toBe("workflow");
    const run = api.calls.find((c) => c.path === "/workflows/wf_pay/execute")!;
    expect(run.body.input.functionArgs).toBe(encodeRedemption(txs).functionArgs);
    expect(run.body.input.chargeId).toBe("ch1");
    expect(run.headers["idempotency-key"]).toContain(encodeRedemption(txs).digest);

    const credit = await ex.send(txs, est.context!, undefined, { purpose: "credit" });
    expect(credit).toBeTruthy();
    expect(api.calls.some((c) => c.path === "/workflows/wf_credit/execute")).toBe(true);

    const st = await ex.getStatus(id);
    expect(st.status).toBe(200);
    expect(st.txHash).toBe(TX);
  });

  test("workflow still running is 110, failed run is 500", async () => {
    const api = new FakeKeeperHub();
    const ex = mkExecutor(api, { workflows: { pay: "wf_pay", recovery: null, settle: null, anchor: null, credit: null, notify: null } });
    const txs = sampleTransactions();
    const id = await ex.send(txs, (await ex.estimate(txs)).context!);
    api.workflowStatus = "running";
    expect((await ex.getStatus(id)).status).toBe(110);
    api.workflowStatus = "error";
    expect((await ex.getStatus(id)).status).toBe(500);
  });

  test("direct execution fallback uses verified receipts", async () => {
    const api = new FakeKeeperHub();
    const ex = mkExecutor(api);
    const txs = sampleTransactions();
    const id = await ex.send(txs, (await ex.estimate(txs)).context!);
    expect(parseKeeperHubRequestId(id)!.surface).toBe("direct");
    const st = await ex.getStatus(id);
    expect(st.status).toBe(200);
    expect(st.txHash).toBe(TX);
    api.directStatus = "unconfirmed";
    expect((await ex.getStatus(id)).status).toBe(110);
  });

  test("dry run can be switched off, but never silently for unknown contexts when on", async () => {
    const api = new FakeKeeperHub();
    const ex = mkExecutor(api, { dryRunRequired: false });
    const id = await ex.send(sampleTransactions(), "anything");
    expect(id.startsWith("kh:dx:")).toBe(true);
  });
});

describe("spend through KeeperHub", () => {
  test("pay: leaf delegated to the KeeperHub wallet, gas fee to the wallet, charge confirmed with KeeperHub tx", async () => {
    const api = new FakeKeeperHub();
    const w = await mkWorld(api, { workflows: { pay: "wf_pay", recovery: null, settle: null, anchor: null, credit: null, notify: null } });
    const receipt = await spend(w.deps, w.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_500_000n, memo: "coffee" });
    expect(receipt.status).toBe("confirmed");
    expect(receipt.tx).toBe(TX);
    expect(receipt.fee).toBe("0.01");

    const run = api.calls.find((c) => c.path === "/workflows/wf_pay/execute")!;
    const [contexts] = JSON.parse(run.body.input.functionArgs) as [Hex[]];
    expect(contexts.length).toBe(1);

    const charge = w.store.listCharges(w.cardId)[0]!;
    expect(charge.request_id!.startsWith("kh:wf:")).toBe(true);
    const records = w.plans.forCharge(charge.id);
    expect(records.map((r) => r.action)).toEqual(["dry_run", "execute"]);
    expect(records[1]!.status).toBe("completed");
    expect(records[1]!.tx_hash).toBe(TX);
  });

  test("an enforcer revert in the dry run is a typed refusal and nothing executes", async () => {
    const api = new FakeKeeperHub();
    api.simulateMode = "revert";
    const w = await mkWorld(api);
    await expect(spend(w.deps, w.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000_000n })).rejects.toThrow();
    expect(api.calls.some((c) => c.path === "/execute/contract-call" && c.body?.simulate !== true)).toBe(false);
    expect(w.store.listCharges(w.cardId).length).toBe(0);
  });

  test("plan -> review -> execute sends exactly the reviewed bytes, once", async () => {
    const api = new FakeKeeperHub();
    const w = await mkWorld(api);
    const plan = await planSpend(w.deps, w.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 2_000_000n, memo: "api credits" });
    expect(plan.status).toBe("planned");
    expect(plan.simulation.redeemer).toBe(WALLET);
    expect(plan.total).toBe("2.01");
    expect(plan.remaining_this_period_after).toBe("22.99");
    // planning moves nothing
    expect(w.store.listCharges(w.cardId).length).toBe(0);
    expect(api.calls.filter((c) => c.path === "/execute/contract-call" && c.body?.simulate !== true).length).toBe(0);

    const receipt = await spend(w.deps, w.cardId, { kind: "pay", mode: "pay", planId: plan.plan_id });
    expect(receipt.status).toBe("confirmed");
    const broadcast = api.calls.filter((c) => c.path === "/execute/contract-call" && c.body?.simulate !== true);
    expect(broadcast.length).toBe(1);
    const simulated = api.calls.filter((c) => c.body?.simulate === true);
    expect(simulated.length).toBe(1); // no second simulation, no re-carve
    expect(broadcast[0]!.body.data).toBe(simulated[0]!.body.data);

    // executing the same plan again replays the receipt; nothing new is sent
    const again = await spend(w.deps, w.cardId, { kind: "pay", mode: "pay", planId: plan.plan_id });
    expect(again.tx).toBe(receipt.tx);
    expect(api.calls.filter((c) => c.path === "/execute/contract-call" && c.body?.simulate !== true).length).toBe(1);
    expect(w.plans.getPlan(plan.plan_id)!.status).toBe("executed");
  });

  test("an expired plan is refused", async () => {
    const api = new FakeKeeperHub();
    const w = await mkWorld(api);
    const plan = await planSpend(w.deps, w.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000_000n });
    const later = { ...w.deps, now: () => NOW + 60 + 3600 };
    await expect(spend(later, w.cardId, { kind: "pay", mode: "pay", planId: plan.plan_id })).rejects.toThrow(/expired/);
    expect(w.plans.getPlan(plan.plan_id)!.status).toBe("expired");
  });

  test("a plan is bound to its card", async () => {
    const api = new FakeKeeperHub();
    const w = await mkWorld(api);
    const plan = await planSpend(w.deps, w.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000_000n });
    await expect(spend(w.deps, "other-card", { kind: "pay", mode: "pay", planId: plan.plan_id })).rejects.toThrow(/no such plan/);
  });

  test("stuck-charge recovery settles a timed-out charge from KeeperHub status", async () => {
    const api = new FakeKeeperHub();
    const w = await mkWorld(api, { workflows: { pay: "wf_pay", recovery: null, settle: null, anchor: null, credit: null, notify: null } });
    api.workflowStatus = "running";
    // the inline confirmation times out: waitForStatus deadline is driven by the fake clock
    const slow = new KeeperHubExecutor({
      config: w.executor.config,
      client: w.executor.client,
      store: w.plans,
      chainId: 8453,
      now: (() => {
        let t = (NOW + 60) * 1000;
        return () => (t += 50_000);
      })(),
      sleep: async () => {},
    });
    const confirmed: string[] = [];
    const deps: SpendDeps = { ...w.deps, relayer: slow, onChargeConfirmed: (id) => confirmed.push(id) };
    const r = await spend(deps, w.cardId, { kind: "pay", mode: "pay", to: MERCHANT, amountAtoms: 1_000_000n });
    expect(r.status).toBe("pending");

    const pendingOnly = await reconcileKeeperHub({ ...deps, now: () => NOW + 600 });
    expect(pendingOnly.still_pending).toBe(1);

    api.workflowStatus = "success";
    const res = await reconcileKeeperHub({ ...deps, now: () => NOW + 600 });
    expect(res.confirmed).toBe(1);
    expect(w.store.listCharges(w.cardId)[0]!.status).toBe("confirmed");
    expect(confirmed.length).toBe(1);
  });
});

describe("workflow routing", () => {
  test("each purpose selects the workflow whose history should record it", () => {
    expect(workflowKeyFor("pay")).toBe("pay");
    expect(workflowKeyFor("credit")).toBe("credit");
    // regression: `settle` used to fall through to `pay`, so KEEPERHUB_WORKFLOW_SETTLE
    // was provisioned and then never executed against.
    expect(workflowKeyFor("settle")).toBe("settle");
  });

  test("x402 and admin redemptions ride the pay workflow", () => {
    expect(workflowKeyFor("x402")).toBe("pay");
    expect(workflowKeyFor("admin")).toBe("pay");
    expect(workflowKeyFor(undefined)).toBe("pay");
  });
});

describe("workflow definitions", () => {
  // hooksEnabled mirrors a Pro org; the free-plan shape is covered separately below.
  const base = { chainId: 8453, publicBaseUrl: "https://api.keepercard.test", hookSecret: "s".repeat(32), hooksEnabled: true };

  test("redemption workflow: manual trigger -> write-contract on DelegationManager -> hook", () => {
    const defs = buildWorkflowDefinitions(base);
    const pay = defs.pay!;
    expect(pay.name).toBe("card-payment-redemption");
    const redeem = pay.nodes.find((n) => n.id === "redeem")!;
    expect(redeem.data.config.actionType).toBe("web3/write-contract");
    expect(redeem.data.config.contractAddress).toBe(DELEGATION_MANAGER);
    expect(redeem.data.config.abiFunction).toBe("redeemDelegations");
    expect(redeem.data.config.functionArgs).toBe("{{@redemption-request:Redemption Request.functionArgs}}");
    expect(redeem.data.config.network).toBe("8453");
    const hook = pay.nodes.find((n) => n.id === "report")!;
    expect(String(hook.data.config.endpoint)).toBe("https://api.keepercard.test/api/keeperhub/hooks/execution");
    expect(pay.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["redemption-request>redeem", "redeem>report"]);
    // labels must not contain ':' (KeeperHub template syntax)
    for (const def of Object.values(defs)) for (const n of def?.nodes ?? []) expect(n.data.label.includes(":")).toBe(false);
  });

  test("scheduled sweeps and optional workflows", () => {
    const defs = buildWorkflowDefinitions(base);
    expect(defs.recovery!.nodes[0]!.data.config.scheduleCron).toBe("*/5 * * * *");
    expect(defs.settle!.nodes[0]!.data.config.triggerType).toBe("Schedule");
    expect(defs.anchor).toBeNull();
    expect(defs.notify).toBeNull();

    const full = buildWorkflowDefinitions({
      ...base,
      paymentAnchorAddress: "0x881c55745372DfCB7dEC9B13F499b167164e2121",
      notify: { discordIntegrationId: "int_discord", webhookUrl: "https://hooks.test/x" },
    });
    const anchor = full.anchor!.nodes.find((n) => n.id === "anchor")!;
    expect(anchor.data.config.network).toBe("11155111");
    expect(anchor.data.config.abiFunction).toBe("anchorPayment");
    expect(full.notify!.nodes.map((n) => n.id)).toEqual(["event", "notify-discord", "notify-webhook"]);
    expect(full.recovery!.edges.some((e) => e.sourceHandle === "true")).toBe(true);
  });

  test("rejects weak hook secrets and relative base URLs", () => {
    expect(() => buildWorkflowDefinitions({ ...base, hookSecret: "short" })).toThrow();
    expect(() => buildWorkflowDefinitions({ ...base, publicBaseUrl: "/api" })).toThrow();
  });

  describe("without the Pro-gated HTTP Request action", () => {
    const free = { ...base, hooksEnabled: false, paymentAnchorAddress: "0x881c55745372DfCB7dEC9B13F499b167164e2121" as const };

    test("value-moving workflows keep their write-contract node and lose only the callback", () => {
      const defs = buildWorkflowDefinitions(free);
      for (const key of ["pay", "credit"] as const) {
        const def = defs[key]!;
        expect(def.nodes.map((n) => n.id)).toEqual(["redemption-request", "redeem"]);
        expect(def.nodes.find((n) => n.id === "redeem")!.data.config.actionType).toBe("web3/write-contract");
        expect(def.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["redemption-request>redeem"]);
      }
      const anchor = defs.anchor!;
      expect(anchor.nodes.map((n) => n.id)).toEqual(["payment-confirmed", "anchor"]);
      expect(anchor.edges.map((e) => `${e.source}>${e.target}`)).toEqual(["payment-confirmed>anchor"]);
    });

    test("no workflow carries an HTTP Request node, which the API would reject with 402", () => {
      const defs = buildWorkflowDefinitions(free);
      for (const def of Object.values(defs)) {
        for (const n of def?.nodes ?? []) expect(n.data.config.actionType).not.toBe("HTTP Request");
      }
    });

    test("hook-only sweeps are dropped, since a lone schedule is not a workflow", () => {
      const defs = buildWorkflowDefinitions(free);
      expect(defs.recovery).toBeNull();
      expect(defs.settle).toBeNull();
    });

    test("the hook secret is not required when nothing calls back", () => {
      expect(() => buildWorkflowDefinitions({ ...free, hookSecret: "" })).not.toThrow();
    });
  });
});

describe("risk assessment", () => {
  const cfg = (): KeeperHubConfig => keeperhubConfig({ KEEPERHUB_API_KEY: "kh_test" } as NodeJS.ProcessEnv)!;

  const clientWith = (result: Record<string, unknown>) =>
    new KeeperHubClient(cfg(), {
      fetch: (async () =>
        new Response(JSON.stringify({ executionId: "x", status: "completed", result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });

  test("a real verdict is not advisory", async () => {
    const r = await clientWith({
      success: true,
      riskLevel: "low",
      riskScore: 5,
      factors: ["known token contract"],
      decodedFunction: "transfer(address,uint256)",
      reasoning: "ordinary ERC20 transfer",
    }).assessRisk({ calldata: "0xdead", chainId: 84532 });
    expect(r.advisory).toBe(false);
    expect(r.level).toBe("low");
    expect(r.score).toBe(5);
  });

  test("the fail-closed default is marked advisory, so it cannot be mistaken for a finding", async () => {
    // KeeperHub returns high/70 when its own analysis fails; gating on that would
    // refuse every payment whenever an upstream AI service is down.
    const r = await clientWith({
      success: true,
      riskLevel: "high",
      riskScore: 70,
      factors: ["AI risk analysis failed -- defaulting to elevated risk (fail-closed policy)"],
      reasoning: "AI assessment failed or timed out.",
    }).assessRisk({ calldata: "0xdead", chainId: 84532 });
    expect(r.level).toBe("high");
    expect(r.advisory).toBe(true);
  });

  test("an unsuccessful assessment is advisory too", async () => {
    const r = await clientWith({ success: false, riskLevel: "critical", error: "upstream down" }).assessRisk({
      calldata: "0xdead",
      chainId: 84532,
    });
    expect(r.advisory).toBe(true);
    expect(r.error).toBe("upstream down");
  });
});

describe("anchor attestation", () => {
  const ANCHOR = "0x881c55745372DfCB7dEC9B13F499b167164e2121" as Address;
  const ONCHAIN_TX = "0x" + "a1".repeat(32);
  const LOCAL_ONLY_TX = "0x" + "b2".repeat(32);

  function world(events: Array<{ hash: string; amount: string }>) {
    const store = new Store(":memory:");
    const kh = new KeeperHubStore(store.db);
    const client = new KeeperHubClient(cfg(), {
      fetch: (async () =>
        new Response(
          JSON.stringify({
            status: "completed",
            result: {
              success: true,
              fromBlock: 100,
              toBlock: 200,
              eventCount: events.length,
              events: events.map((e, i) => ({
                blockNumber: 150 + i,
                transactionHash: e.hash,
                logIndex: 0,
                args: { cardId: "0xcard", payer: WALLET, merchant: MERCHANT, amount: e.amount, memo: "m" },
              })),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    return { kh, client };
  }

  const anchorRow = (txHash: string) => ({
    execution_id: `ex_${txHash.slice(2, 10)}`,
    surface: "direct" as const,
    workflow_key: "anchor" as const,
    workflow_id: null,
    action: "anchor" as const,
    card_id: null,
    charge_id: "ch1",
    digest: null,
    status: "completed" as const,
    tx_hash: txHash as Hex,
    chain_id: 11155111,
    error: null,
  });

  test("a local row the chain confirms is matched", async () => {
    const { kh, client } = world([{ hash: ONCHAIN_TX, amount: "1000000" }]);
    kh.record(anchorRow(ONCHAIN_TX));
    const r = await attestAnchors({ client, store: kh, anchorAddress: ANCHOR });
    expect(r.matched.length).toBe(1);
    expect(r.unwitnessed.length).toBe(0);
    expect(r.unrecorded.length).toBe(0);
    expect(r.matched[0]!.amount).toBe("1000000");
  });

  test("a local claim with no event in the window is unwitnessed, and the window is reported", async () => {
    const { kh, client } = world([]);
    kh.record(anchorRow(LOCAL_ONLY_TX));
    const r = await attestAnchors({ client, store: kh, anchorAddress: ANCHOR });
    expect(r.unwitnessed.length).toBe(1);
    // the caller must be able to see the scan was bounded before calling this a lie
    expect(r.from_block).toBe(100);
    expect(r.to_block).toBe(200);
  });

  test("an on-chain anchor AttestPay never recorded is surfaced", async () => {
    const { kh, client } = world([{ hash: ONCHAIN_TX, amount: "500000" }]);
    const r = await attestAnchors({ client, store: kh, anchorAddress: ANCHOR });
    expect(r.unrecorded.length).toBe(1);
    expect(r.unrecorded[0]!.tx_hash).toBe(ONCHAIN_TX as Hex);
  });

  test("a failed chain read reports an error rather than an empty all-clear", async () => {
    const kh = new KeeperHubStore(new Store(":memory:").db);
    const client = new KeeperHubClient(cfg(), {
      fetch: (async () =>
        new Response(JSON.stringify({ result: { success: false, error: "rpc down" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    const r = await attestAnchors({ client, store: kh, anchorAddress: ANCHOR });
    expect(r.error).toBe("rpc down");
    expect(r.matched.length).toBe(0);
  });
});
