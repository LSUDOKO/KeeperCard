// Dashboard REST surface for the KeeperHub execution layer. Mounted under /api, so it
// inherits the session/admin auth and card scoping of the parent router.
//
//   GET  /keeperhub/status                   execution layer config, wallet, workflows, 24h stats
//   GET  /keeperhub/workflows                live workflow list + recent runs from KeeperHub
//   GET  /keeperhub/executions               recent KeeperHub records (admin: all; user: own cards)
//   GET  /keeperhub/executions/:executionId  one execution, live from KeeperHub (status + logs)
//   GET  /cards/:id/keeperhub                a card's audit trail: dry runs, runs, plans
//   POST /cards/:id/keeperhub/dry-run        compose + dry-run a payment (reviewed plan)
//   POST /cards/:id/keeperhub/execute        execute a reviewed plan, byte for byte

import { Hono } from "hono";
import type { Address } from "viem";
import {
  CHAIN_ID,
  CHAINS,
  EngineError,
  RefusalError,
  atomsToUsdc,
  keeperhub,
  planSpend,
  spend,
  usdcToAtoms,
} from "@attestpay/engine";
import type { ApiEnv } from "../api/routes";
import { spendDeps, spendKey, type AppDeps } from "../deps";
import type { Handle, OwnedCardResolver } from "../events/routes";

const HOUR = 3600;

export function explorerTx(chainId: number | null, hash: string | null): string | null {
  if (!hash) return null;
  switch (chainId) {
    case 8453:
      return `https://basescan.org/tx/${hash}`;
    case 84532:
      return `https://sepolia.basescan.org/tx/${hash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${hash}`;
    default:
      return null;
  }
}

export function presentExecution(r: keeperhub.KeeperHubExecutionRow) {
  return {
    id: r.id,
    execution_id: r.execution_id,
    surface: r.surface,
    workflow: r.workflow_key ? (keeperhub.KEEPERHUB_WORKFLOW_NAMES as Record<string, string>)[r.workflow_key] ?? r.workflow_key : null,
    workflow_id: r.workflow_id,
    action: r.action,
    status: r.status,
    card_id: r.card_id,
    charge_id: r.charge_id,
    digest: r.digest,
    chain_id: r.chain_id,
    tx_hash: r.tx_hash,
    tx_url: explorerTx(r.chain_id, r.tx_hash),
    error: r.error,
    detail: r.detail,
    created_at: new Date(r.created_at * 1000).toISOString(),
    updated_at: new Date(r.updated_at * 1000).toISOString(),
  };
}

export function presentPlan(p: keeperhub.SpendPlanRow) {
  return {
    plan_id: p.id,
    card_id: p.card_id,
    status: p.status,
    digest: p.digest,
    to: p.to_addr,
    amount: atomsToUsdc(p.amount_atoms),
    fee: atomsToUsdc(p.fee_atoms),
    memo: p.memo,
    simulation: p.simulation,
    charge_id: p.charge_id,
    created_at: new Date(p.created_at * 1000).toISOString(),
    expires_at: new Date(p.expires_at * 1000).toISOString(),
  };
}

/**
 * KeeperHub's risk verdict, without the raw payload and with the one distinction that
 * matters stated in words: `available: false` means the assessor never reached a
 * verdict, so `level` is its fail-closed default rather than a finding about this
 * calldata. Callers that blur the two either cry wolf or refuse every payment whenever
 * an upstream AI service is down.
 */
export function presentRisk(r: keeperhub.RiskAssessment | null | undefined) {
  if (!r) return null;
  return {
    available: !r.advisory,
    level: r.level,
    score: r.score,
    decoded_function: r.decodedFunction,
    factors: r.factors,
    reasoning: r.reasoning,
    note: r.advisory
      ? "KeeperHub's risk assessor did not return a verdict (its analysis failed); this level is a fail-closed default, not a finding about this payment"
      : null,
  };
}

export type ScopedUser = (c: Parameters<Handle>[0]) => string;

export function keeperhubRoutes(deps: AppDeps, ownedCard: OwnedCardResolver, handle: Handle, scopedUser: ScopedUser): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();
  const now = () => Math.floor(Date.now() / 1000);
  const kh = () => {
    if (!deps.keeperhub) throw new EngineError("keeperhub_not_configured", "KeeperHub is not wired on this deployment");
    return deps.keeperhub;
  };
  const client = () => {
    const c = kh().client;
    if (!c) throw new EngineError("keeperhub_not_configured", kh().disabledReason ?? "KeeperHub is not configured");
    return c;
  };

  app.get("/keeperhub/status", (c) =>
    handle(c, async () => {
      const k = deps.keeperhub;
      const cfg = k?.config ?? null;
      let wallet: string | null = cfg?.walletAddress ?? null;
      let walletError: string | null = null;
      if (cfg && !wallet) {
        try {
          wallet = await deps.relayer.delegateAddress();
        } catch (e) {
          walletError = e instanceof Error ? e.message : String(e);
        }
      }
      return {
        executor: deps.relayer.kind,
        enabled: !!cfg,
        disabled_reason: k?.disabledReason ?? (k ? null : "not wired"),
        chain_id: CHAIN_ID,
        chain: CHAINS[CHAIN_ID].name,
        wallet,
        wallet_error: walletError,
        api_base: cfg?.apiBase ?? null,
        mcp_url: cfg?.mcpUrl ?? null,
        dry_run_required: cfg?.dryRunRequired ?? null,
        plan_ttl_seconds: cfg?.planTtlSeconds ?? null,
        gas_fee_usdc: cfg?.gasFeeUsdc ?? null,
        hooks_configured: !!cfg?.hookSecret,
        anchoring_via_keeperhub: !!k?.anchorer,
        workflows: keeperhub.KEEPERHUB_WORKFLOW_KEYS.map((key) => ({
          key,
          name: keeperhub.KEEPERHUB_WORKFLOW_NAMES[key],
          id: cfg?.workflows[key] ?? null,
        })),
        stats_24h: k ? k.store.stats(now() - 24 * HOUR) : null,
      };
    }),
  );

  app.get("/keeperhub/workflows", (c) =>
    handle(c, async () => {
      const cfg = kh().config;
      const kc = client();
      const out = [];
      for (const key of keeperhub.KEEPERHUB_WORKFLOW_KEYS) {
        const id = cfg?.workflows[key] ?? null;
        if (!id) {
          out.push({ key, name: keeperhub.KEEPERHUB_WORKFLOW_NAMES[key], id: null, provisioned: false, runs: [] });
          continue;
        }
        try {
          const [wf, runs] = await Promise.all([kc.getWorkflow(id), kc.listWorkflowExecutions(id)]);
          out.push({
            key,
            name: wf.name,
            id,
            provisioned: true,
            enabled: wf.enabled ?? null,
            description: wf.description ?? null,
            nodes: wf.nodes.map((n) => ({ id: n.id, label: n.data.label, type: n.data.config.actionType ?? n.data.config.triggerType ?? n.type })),
            edges: wf.edges.map((e) => ({ source: e.source, target: e.target, handle: e.sourceHandle ?? null })),
            runs: runs.slice(0, 10),
          });
        } catch (e) {
          out.push({ key, name: keeperhub.KEEPERHUB_WORKFLOW_NAMES[key], id, provisioned: true, error: e instanceof Error ? e.message : String(e), runs: [] });
        }
      }
      return { workflows: out };
    }),
  );

  app.get("/keeperhub/executions", (c) =>
    handle(c, async () => {
      const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200);
      const auth = c.get("auth");
      const k = kh();
      if (auth.kind === "admin") {
        const action = c.req.query("action") as keeperhub.KeeperHubAction | undefined;
        return { executions: k.store.recent(limit, action ? { action } : {}).map(presentExecution) };
      }
      // a signed-in user sees records for their own cards only
      const cards = deps.store.listCards(scopedUser(c));
      return { executions: k.store.forCards(cards.map((x) => x.id), limit).map(presentExecution) };
    }),
  );

  app.get("/keeperhub/executions/:executionId", (c) =>
    handle(c, async () => {
      const k = kh();
      const executionId = c.req.param("executionId");
      const record = k.store.byExecutionId(executionId);
      if (!record) throw new RefusalError("card_not_found", "no such KeeperHub execution for this deployment");
      if (record.card_id) ownedCard(c, record.card_id, "read");
      else if (c.get("auth").kind !== "admin") throw new RefusalError("card_not_found", "no such KeeperHub execution");

      const kc = client();
      let live: unknown = null;
      let logs: unknown = null;
      try {
        if (record.surface === "workflow") {
          live = await kc.workflowExecutionStatus(executionId);
          logs = (await kc.workflowExecutionLogs(executionId)).logs.map((l) => ({
            node: l.nodeName,
            type: l.nodeType,
            status: l.status,
            error: l.error,
            duration_ms: l.duration,
            output: l.output,
          }));
        } else {
          live = await kc.directExecutionStatus(executionId);
        }
      } catch (e) {
        live = { error: e instanceof Error ? e.message : String(e) };
      }
      // refresh the local record from the verified answer
      if (record.action === "execute") await deps.relayer.getStatus(keeperhub.keeperhubRequestId(record.surface, executionId));
      return { record: presentExecution(k.store.byExecutionId(executionId) ?? record), live, logs };
    }),
  );

  app.get("/cards/:id/keeperhub", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "read");
      const k = kh();
      const ids = deps.store.subtreeIds(card.id);
      const limit = Math.min(Number(c.req.query("limit") ?? "50") || 50, 200);
      return {
        card_id: card.id,
        executor: deps.relayer.kind,
        executions: k.store.forCards(ids, limit).map(presentExecution),
        plans: k.store.plansForCard(card.id, 20).map(presentPlan),
      };
    }),
  );

  app.post("/cards/:id/keeperhub/dry-run", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "control");
      const b = (await c.req.json().catch(() => ({}))) as { to?: string; amount?: string; memo?: string };
      if (!b.to || !/^0x[0-9a-fA-F]{40}$/.test(b.to)) throw new RefusalError("invalid_terms", "to must be an address");
      if (!b.amount || !/^\d+(\.\d{1,6})?$/.test(b.amount)) throw new RefusalError("invalid_terms", "amount must be a USDC decimal");
      if (!card.terms.pay) throw new RefusalError("invalid_terms", "this card has no pay capability");
      return deps.spendMutex.run(spendKey(deps.store, card.id), () =>
        planSpend(spendDeps(deps), card.id, {
          kind: "pay",
          mode: "pay",
          to: b.to as Address,
          amountAtoms: usdcToAtoms(b.amount!),
          memo: b.memo?.slice(0, 280),
        }),
      );
    }),
  );

  app.post("/cards/:id/keeperhub/execute", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "control");
      const b = (await c.req.json().catch(() => ({}))) as { plan_id?: string };
      if (!b.plan_id) throw new RefusalError("invalid_terms", "plan_id is required");
      const receipt = await deps.spendMutex.run(spendKey(deps.store, card.id), () =>
        spend(spendDeps(deps), card.id, { kind: "pay", mode: "pay", planId: b.plan_id }),
      );
      const plan = kh().store.getPlan(b.plan_id);
      return { receipt, plan: plan ? presentPlan(plan) : null, tx_url: explorerTx(CHAIN_ID, receipt.tx) };
    }),
  );

  return app;
}
