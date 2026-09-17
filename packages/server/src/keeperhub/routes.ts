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
import { privateKeyToAccount } from "viem/accounts";
import type { ApiEnv } from "../api/routes";
import { spendDeps, spendKey, type AppDeps } from "../deps";
import type { Handle, OwnedCardResolver } from "../events/routes";

const HOUR = 3600;

function sponsorAddress(pk: string): `0x${string}` | null {
  try {
    return privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`).address;
  } catch {
    return null;
  }
}

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

/** A receipt with both of its transactions linked: the payment, and the anchor that records it. */
export function presentReceipt(r: keeperhub.ReceiptView) {
  return {
    ...r,
    anchor_url: explorerTx(r.anchor_chain_id, r.anchor_tx),
    payment_url: explorerTx(r.payment_chain_id, r.payment_tx),
  };
}

const usdc6 = (atoms: string | null): string | null => (atoms === null ? null : (Number(atoms) / 1e6).toFixed(6));
const eth18 = (wei: string | null): string | null => (wei === null ? null : (Number(wei) / 1e18).toFixed(8));

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
          out.push({
            key,
            name: keeperhub.KEEPERHUB_WORKFLOW_NAMES[key],
            trigger: keeperhub.KEEPERHUB_WORKFLOW_TRIGGERS[key],
            id: null,
            provisioned: false,
            // recovery/sweep are schedule + HTTP callback, a Pro action; notify needs an integration
            unavailable_reason:
              key === "recovery" || key === "sweep"
                ? "needs KeeperHub Pro (HTTP Request action); KeeperCard runs this timer in-process instead"
                : key === "notify"
                  ? "no notification integration configured"
                  : key === "anchor" || key === "receipts"
                    ? "KEEPERHUB_RECEIPT_ANCHOR_ADDRESS is not set"
                    : "not provisioned yet: run keeperhub:provision",
            runs: [],
          });
          continue;
        }
        try {
          const [wf, runs] = await Promise.all([kc.getWorkflow(id), kc.listWorkflowExecutions(id)]);
          out.push({
            key,
            name: wf.name,
            trigger: keeperhub.KEEPERHUB_WORKFLOW_TRIGGERS[key],
            id,
            provisioned: true,
            enabled: wf.enabled ?? null,
            description: wf.description ?? null,
            nodes: wf.nodes.map((n) => ({ id: n.id, label: n.data.label, type: n.data.config.actionType ?? n.data.config.triggerType ?? n.type })),
            edges: wf.edges.map((e) => ({ source: e.source, target: e.target, handle: e.sourceHandle ?? null })),
            runs: runs.slice(0, 10),
          });
        } catch (e) {
          out.push({ key, name: keeperhub.KEEPERHUB_WORKFLOW_NAMES[key], trigger: keeperhub.KEEPERHUB_WORKFLOW_TRIGGERS[key], id, provisioned: true, error: e instanceof Error ? e.message : String(e), runs: [] });
        }
      }
      return { workflows: out };
    }),
  );

  // The audit trail's independent witness: KeeperCard's anchor records checked against
  // the PaymentAnchored events the chain actually holds. Admin-only, because it reports
  // across every card's anchors rather than one caller's subtree.
  app.get("/keeperhub/attestation", (c) =>
    handle(c, async () => {
      if (c.get("auth").kind !== "admin") throw new RefusalError("card_not_found", "attestation is an operator view");
      const anchorAddress = kh().config?.receiptAnchorAddress;
      if (!anchorAddress) throw new RefusalError("invalid_terms", "no PaymentAnchor is configured on this deployment (KEEPERHUB_RECEIPT_ANCHOR_ADDRESS)");
      const blockCount = Math.min(Number(c.req.query("blocks") ?? "6500") || 6500, 50_000);
      const report = await keeperhub.attestAnchors({
        client: client(),
        store: kh().store,
        anchorAddress,
        anchorChainId: CHAIN_ID,
        blockCount,
      });
      return {
        ...report,
        summary: {
          matched: report.matched.length,
          unwitnessed: report.unwitnessed.length,
          unrecorded: report.unrecorded.length,
        },
        note: "Only the scanned window is covered: an anchor older than from_block is not looked at, so `unwitnessed` means 'no event in this range', never 'did not happen'.",
      };
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

  // Live treasury state, every figure read through KeeperHub: the wallets payments
  // depend on, and the Chainlink reference prices the depeg guard uses.
  app.get("/keeperhub/treasury", (c) =>
    handle(c, async () => {
      const cfg = kh().config;
      if (!cfg) throw new RefusalError("invalid_terms", "KeeperHub is not configured on this deployment");
      const orgWallet = (cfg.walletAddress ?? (await deps.relayer.delegateAddress().catch(() => null))) as `0x${string}` | null;
      const sponsorPk = process.env.ATTESTPAY_7702_SPONSOR_PK?.trim();
      const sponsorWallet = sponsorPk ? sponsorAddress(sponsorPk) : null;
      const t = await keeperhub.readTreasury({
        client: client(),
        chainId: CHAIN_ID,
        usdc: CHAINS[CHAIN_ID].usdc,
        orgWallet,
        sponsorWallet,
        depegFloor: cfg.depegFloor,
      });
      const wallet = (w: keeperhub.WalletHealth | null, role: string) =>
        w ? { role, address: w.address, gas_eth: eth18(w.gas_wei), usdc: usdc6(w.usdc_atoms), gas_low: w.gas_low } : null;
      return {
        chain_id: t.chain_id,
        chain: CHAINS[CHAIN_ID].name,
        wallets: [wallet(t.org_wallet, "KeeperHub org wallet (executes payments)"), wallet(t.sponsor_wallet, "EIP-7702 sponsor")].filter(Boolean),
        usdc_usd: t.usdc_usd,
        eth_usd: t.eth_usd,
        usdc_depegged: t.usdc_depegged,
        depeg_floor: t.depeg_floor,
        guarded_min_usdc: cfg.guardedMinUsdc,
        note: "Read live through KeeperHub. A null figure means the read failed — unknown, not zero.",
      };
    }),
  );

  // On-chain receipts for a card's confirmed payments.
  app.get("/cards/:id/receipts", (c) =>
    handle(c, async () => {
      const card = ownedCard(c, c.req.param("id"), "read");
      const k = kh();
      if (!k.receipts) return { configured: false, anchor: null, items: [] };
      const items = deps.store
        .subtreeIds(card.id)
        .flatMap((id) => deps.store.listCharges(id, 50))
        .filter((ch) => ch.status === "confirmed" && ch.tx_hash)
        .map((ch) => ({ ...presentReceipt(k.receipts!.view(ch.id)), amount: atomsToUsdc(ch.amount_atoms), memo: ch.memo, card_id: ch.card_id }));
      return { configured: true, anchor: k.config?.receiptAnchorAddress ?? null, anchor_chain_id: CHAIN_ID, items };
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
