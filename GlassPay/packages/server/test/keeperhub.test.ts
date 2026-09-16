// KeeperHub through the REAL app: a real MCP client and real HTTP routes, with only
// KeeperHub's API faked (shapes from KeeperHub's route code). Covers the agent flow
// the hackathon brief describes: compose -> dry run -> review -> execute exactly that,
// plus the callback hooks, the REST audit surface, and the fail-loud unconfigured lane.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { KeyedMutex, Store, issueRootCard, keeperhub, type CardTerms } from "@attestpay/engine";
import { createApp } from "../src/app";
import type { AppDeps } from "../src/deps";
import { EventBus } from "../src/events/bus";
import { EventStore } from "../src/events/store";
import { installNotificationRelay, notificationText } from "../src/keeperhub/notify";

const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127";
const WALLET = "0x7777777777777777777777777777777777777777" as Address;
const TX = `0x${"5a".repeat(32)}` as Hex;
const HOOK_SECRET = "hook-secret-".padEnd(40, "x");
const user = privateKeyToAccount(generatePrivateKey());

type Call = { method: string; path: string; body: any; key?: string };

class FakeKeeperHub {
  calls: Call[] = [];
  runStatus: "running" | "success" | "error" = "success";
  private runs = 0;
  private idem = new Map<string, string>();

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const key = (init?.headers as Record<string, string> | undefined)?.["idempotency-key"];
    const method = init?.method ?? "GET";
    this.calls.push({ method, path, body, key });
    const json = (s: number, d: unknown) => new Response(JSON.stringify(d), { status: s });

    if (path === "/integrations") return json(200, [{ id: "i", name: "wallet", type: "web3", address: WALLET }]);
    if (path === "/execute/contract-call" && body?.simulate) {
      return json(200, { success: true, status: "simulated", from: WALLET, to: body.contractAddress, gasEstimate: "171000", wouldRevert: false });
    }
    const exec = /^\/workflows\/([^/]+)\/execute$/.exec(path);
    if (exec) {
      const id = (key && this.idem.get(key)) ?? `run_${++this.runs}`;
      if (key) this.idem.set(key, id);
      return json(200, { executionId: id, status: "running" });
    }
    if (/^\/workflows\/executions\/[^/]+\/status$/.test(path)) {
      return json(200, {
        status: this.runStatus,
        nodeStatuses: [],
        progress: { totalSteps: 3, completedSteps: 3, percentage: 100 },
        transactionHashes: this.runStatus === "success" ? [{ hash: TX, nodeId: "redeem", nodeName: "Redeem Delegations", verified: true, blockNumber: 1 }] : [],
      });
    }
    if (/^\/workflows\/executions\/[^/]+\/logs$/.test(path)) {
      return json(200, { execution: {}, logs: [{ id: "l1", nodeId: "redeem", nodeName: "Redeem Delegations", nodeType: "action", status: "success", input: {}, output: { transactionHash: TX }, error: null, duration: 1200 }] });
    }
    return json(404, { error: `no route ${method} ${path}` });
  };
}

function khConfig(): keeperhub.KeeperHubConfig {
  return {
    apiKey: "kh_test",
    apiBase: "https://kh.test/api",
    mcpUrl: "https://kh.test/mcp",
    walletAddress: null,
    workflows: { pay: "wf_pay", recovery: "wf_recovery", settle: "wf_settle", anchor: null, credit: "wf_credit", notify: "wf_notify" },
    dryRunRequired: true,
    planTtlSeconds: 600,
    gasFeeUsdc: "0.01",
    gasLimitMultiplier: "1.5",
    hookSecret: HOOK_SECRET,
  };
}

let server: ReturnType<typeof Bun.serve>;
let base: string;
let store: Store;
let api: FakeKeeperHub;
let deps: AppDeps;

beforeAll(() => {
  process.env.ATTESTPAY_MASTER_KEY = "e".repeat(64);
  store = new Store(":memory:");
  api = new FakeKeeperHub();
  const config = khConfig();
  const client = new keeperhub.KeeperHubClient(config, { fetch: api.fetch, sleep: async () => {} });
  const khStore = new keeperhub.KeeperHubStore(store.db);
  const executor = new keeperhub.KeeperHubExecutor({ config, client, store: khStore, sleep: async () => {} });
  deps = {
    spendMutex: new KeyedMutex(),
    store,
    relayer: executor,
    userSigner: user,
    adminToken: "test-admin",
    verifyPrivyToken: null,
    spendOverrides: { codeCheck: async () => true, feeJitter: (b) => b },
    events: new EventBus(new EventStore(store.db), store),
    keeperhub: { mode: "keeperhub", config, client, store: khStore, anchorer: null, disabledReason: null },
  };
  const app = createApp(deps);
  server = Bun.serve({ port: 0, fetch: app.fetch });
  base = `http://localhost:${server.port}`;
  process.env.ATTESTPAY_PUBLIC_MCP_BASE = base;
  store.upsertUser({ id: "u-kh", address: user.address });
});

afterAll(() => server.stop(true));

async function issue(terms: CardTerms = { pay: { period: { amount: "25", seconds: 604800 } } }) {
  const issued = await issueRootCard({ store, userSigner: user, revocationNonceOverride: 0n }, { userId: "u-kh", name: "kh", terms });
  return { cardId: issued.cardId, secret: issued.secret };
}

async function connect(secret: string): Promise<Client> {
  const client = new Client({ name: "kh-agent", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/c/${secret}/mcp`)));
  return client;
}

const parse = (r: { content?: unknown }) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
const admin = { authorization: "Bearer test-admin", "content-type": "application/json" };

describe("MCP: compose -> dry run -> review -> execute", () => {
  test("KeeperHub tools are offered on a KeeperHub deployment", async () => {
    const { secret } = await issue();
    const client = await connect(secret);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("keeperhub_dry_run");
    expect(names).toContain("keeperhub_execution_status");
    expect(names).toContain("keeperhub_audit_trail");
    await client.close();
  });

  test("dry run moves nothing; pay(plan_id) executes the reviewed bytes through the workflow", async () => {
    const { secret, cardId } = await issue();
    const client = await connect(secret);
    const before = api.calls.length;

    const plan = parse(await client.callTool({ name: "keeperhub_dry_run", arguments: { to: MERCHANT, amount: "3.5", memo: "dataset" } }));
    expect(plan.status).toBe("planned");
    expect(plan.simulation.redeemer).toBe(WALLET);
    expect(plan.simulation.gas_estimate).toBe("171000");
    expect(plan.total).toBe("3.51");
    expect(store.listCharges(cardId).length).toBe(0);
    expect(api.calls.slice(before).some((c) => c.path.endsWith("/execute"))).toBe(false);

    const receipt = parse(await client.callTool({ name: "pay", arguments: { plan_id: plan.plan_id } }));
    expect(receipt.status).toBe("confirmed");
    expect(receipt.tx).toBe(TX);
    expect(receipt.amount).toBe("3.5");

    const runs = api.calls.slice(before).filter((c) => c.path === "/workflows/wf_pay/execute");
    expect(runs.length).toBe(1);
    expect(runs[0]!.body.input.digest).toBe(plan.digest);

    const status = parse(await client.callTool({ name: "keeperhub_execution_status", arguments: { plan_id: plan.plan_id } }));
    expect(status.execution.status).toBe("completed");
    expect(status.execution.tx_hash).toBe(TX);
    expect(status.logs[0].node).toBe("Redeem Delegations");

    const trail = parse(await client.callTool({ name: "keeperhub_audit_trail", arguments: {} }));
    expect(trail.charges[0].ledger_status).toBe("confirmed");
    expect(trail.charges[0].keeperhub.map((k: { action: string }) => k.action)).toEqual(["dry_run", "execute"]);
    await client.close();
  });

  test("pay without a plan still dry-runs before executing", async () => {
    const { secret } = await issue();
    const client = await connect(secret);
    const before = api.calls.length;
    const receipt = parse(await client.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "1" } }));
    expect(receipt.status).toBe("confirmed");
    const mine = api.calls.slice(before);
    const simIdx = mine.findIndex((c) => c.body?.simulate === true);
    const runIdx = mine.findIndex((c) => c.path.endsWith("/execute"));
    expect(simIdx).toBeGreaterThanOrEqual(0);
    expect(runIdx).toBeGreaterThan(simIdx);
    await client.close();
  });

  test("pay with neither plan nor recipient is a typed refusal", async () => {
    const { secret } = await issue();
    const client = await connect(secret);
    const r = await client.callTool({ name: "pay", arguments: {} });
    expect(r.isError).toBe(true);
    expect(parse(r).code).toBe("invalid_terms");
    await client.close();
  });

  test("a plan cannot be executed by another card", async () => {
    const a = await issue();
    const b = await issue();
    const ca = await connect(a.secret);
    const plan = parse(await ca.callTool({ name: "keeperhub_dry_run", arguments: { to: MERCHANT, amount: "1" } }));
    const cb = await connect(b.secret);
    const r = await cb.callTool({ name: "pay", arguments: { plan_id: plan.plan_id } });
    expect(r.isError).toBe(true);
    await ca.close();
    await cb.close();
  });
});

describe("hooks", () => {
  test("reject a missing or wrong secret", async () => {
    expect((await fetch(`${base}/api/keeperhub/hooks/recovery`, { method: "POST" })).status).toBe(401);
    const wrong = await fetch(`${base}/api/keeperhub/hooks/recovery`, { method: "POST", headers: { [keeperhub.HOOK_SECRET_HEADER]: "nope" } });
    expect(wrong.status).toBe(401);
  });

  test("recovery settles a stuck charge from KeeperHub's verified status, not from the hook body", async () => {
    const { cardId } = await issue();
    // a charge whose inline confirmation never finished
    api.runStatus = "running";
    const id = crypto.randomUUID();
    store.insertCharge({
      id,
      card_id: cardId,
      idempotency_key: null,
      kind: "pay",
      to_addr: MERCHANT as Address,
      amount_atoms: 2_000_000n,
      fee_atoms: 10_000n,
      request_id: "kh:wf:run_stuck",
      tx_hash: null,
      status: "pending",
      memo: null,
      created_at: Math.floor(Date.now() / 1000) - 3600,
    });

    const headers = { [keeperhub.HOOK_SECRET_HEADER]: HOOK_SECRET, "content-type": "application/json" };
    let res = await (await fetch(`${base}/api/keeperhub/hooks/recovery`, { method: "POST", headers })).json();
    expect(res.still_pending).toBeGreaterThanOrEqual(1);
    expect(store.getCharge(id)!.status).toBe("pending");

    // a forged "it landed" body changes nothing while KeeperHub still says running
    await fetch(`${base}/api/keeperhub/hooks/execution`, { method: "POST", headers, body: JSON.stringify({ chargeId: id, transactionHash: `0x${"00".repeat(32)}` }) });
    expect(store.getCharge(id)!.status).toBe("pending");

    api.runStatus = "success";
    res = await (await fetch(`${base}/api/keeperhub/hooks/execution`, { method: "POST", headers, body: JSON.stringify({ chargeId: id }) })).json();
    expect(res.confirmed).toBe(1);
    expect(store.getCharge(id)!.status).toBe("confirmed");
    expect(store.getCharge(id)!.tx_hash).toBe(TX);
  });

  test("settle hook reports settlement off when the fiat lane is disabled", async () => {
    const res = await fetch(`${base}/api/keeperhub/hooks/settle`, { method: "POST", headers: { [keeperhub.HOOK_SECRET_HEADER]: HOOK_SECRET } });
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(false);
  });
});

describe("REST", () => {
  test("status describes the execution layer", async () => {
    const s = await (await fetch(`${base}/api/keeperhub/status`, { headers: admin })).json();
    expect(s.executor).toBe("keeperhub");
    expect(s.enabled).toBe(true);
    expect(s.wallet).toBe(WALLET);
    expect(s.dry_run_required).toBe(true);
    expect(s.workflows.find((w: { key: string }) => w.key === "pay").id).toBe("wf_pay");
    expect(s.stats_24h.dry_runs).toBeGreaterThan(0);
  });

  test("dashboard dry-run then execute", async () => {
    const { cardId } = await issue();
    const plan = await (
      await fetch(`${base}/api/cards/${cardId}/keeperhub/dry-run`, { method: "POST", headers: admin, body: JSON.stringify({ to: MERCHANT, amount: "2" }) })
    ).json();
    expect(plan.status).toBe("planned");
    const done = await (
      await fetch(`${base}/api/cards/${cardId}/keeperhub/execute`, { method: "POST", headers: admin, body: JSON.stringify({ plan_id: plan.plan_id }) })
    ).json();
    expect(done.receipt.status).toBe("confirmed");
    expect(done.plan.status).toBe("executed");
    expect(done.tx_url).toContain(TX);

    const trail = await (await fetch(`${base}/api/cards/${cardId}/keeperhub`, { headers: admin })).json();
    expect(trail.plans[0].plan_id).toBe(plan.plan_id);
    expect(trail.executions.some((e: { action: string; status: string }) => e.action === "execute" && e.status === "completed")).toBe(true);
    const exec = trail.executions.find((e: { action: string }) => e.action === "execute");
    const detail = await (await fetch(`${base}/api/keeperhub/executions/${exec.execution_id}`, { headers: admin })).json();
    expect(detail.record.execution_id).toBe(exec.execution_id);
    expect(detail.logs.length).toBe(1);
  });

  test("unauthenticated access is refused", async () => {
    expect((await fetch(`${base}/api/keeperhub/status`)).status).toBe(401);
  });
});

describe("notification relay", () => {
  test("relays budget.low through the notify workflow, not charge.confirmed", async () => {
    const { cardId } = await issue();
    const relayed = installNotificationRelay(deps);
    expect(relayed).toBe(true);
    const before = api.calls.length;
    deps.events!.emit("charge.confirmed", { cardId }, { charge_id: "x" });
    deps.events!.emit("budget.low", { cardId }, { remaining_this_period: "2", period_budget: "25", remaining_pct: 8, threshold_pct: 10 });
    await new Promise((r) => setTimeout(r, 50));
    const runs = api.calls.slice(before).filter((c) => c.path === "/workflows/wf_notify/execute");
    expect(runs.length).toBe(1);
    expect(runs[0]!.body.input.event).toBe("budget.low");
    expect(runs[0]!.body.input.message).toContain("2 of 25 USDC");
  });

  test("notification text is human readable", () => {
    const t = notificationText({ id: "e", type: "proof.failed", user_id: null, card_id: "abcdef123", data: { error: "boom" }, created_at: 0 }, "ops card");
    expect(t.message).toContain('"ops card"');
    expect(t.message).toContain("boom");
  });
});

describe("unconfigured KeeperHub fails loudly", () => {
  test("every payment names the missing configuration; status reads still work", async () => {
    const s2 = new Store(":memory:");
    s2.upsertUser({ id: "u2", address: user.address });
    const d2: AppDeps = {
      spendMutex: new KeyedMutex(),
      store: s2,
      relayer: new keeperhub.UnconfiguredKeeperHubExecutor("KEEPERHUB_API_KEY is not set"),
      userSigner: user,
      adminToken: "test-admin",
      verifyPrivyToken: null,
      spendOverrides: { codeCheck: async () => true },
      keeperhub: { mode: "keeperhub", config: null, client: null, store: new keeperhub.KeeperHubStore(s2.db), anchorer: null, disabledReason: "KEEPERHUB_API_KEY is not set" },
    };
    const app2 = createApp(d2);
    const srv = Bun.serve({ port: 0, fetch: app2.fetch });
    const prevBase = process.env.ATTESTPAY_PUBLIC_MCP_BASE;
    process.env.ATTESTPAY_PUBLIC_MCP_BASE = `http://localhost:${srv.port}`;
    try {
      const issued = await issueRootCard({ store: s2, userSigner: user, revocationNonceOverride: 0n }, { userId: "u2", name: "x", terms: { pay: { period: { amount: "5", seconds: 86400 } } } });
      const client = new Client({ name: "a", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${srv.port}/c/${issued.secret}/mcp`)));
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("keeperhub_dry_run");
      const r = await client.callTool({ name: "pay", arguments: { to: MERCHANT, amount: "1" } });
      expect(r.isError).toBe(true);
      expect(parse(r).message).toContain("keeperhub_not_configured");
      expect(parse(r).message).toContain("KEEPERHUB_API_KEY");
      expect(s2.listCharges(issued.cardId).length).toBe(0);
      await client.close();

      const st = await (await fetch(`http://localhost:${srv.port}/api/keeperhub/status`, { headers: admin })).json();
      expect(st.enabled).toBe(false);
      expect(st.disabled_reason).toContain("KEEPERHUB_API_KEY");
      const hook = await fetch(`http://localhost:${srv.port}/api/keeperhub/hooks/recovery`, { method: "POST" });
      expect(hook.status).toBe(503);
    } finally {
      process.env.ATTESTPAY_PUBLIC_MCP_BASE = prevBase;
      srv.stop(true);
    }
  });
});
