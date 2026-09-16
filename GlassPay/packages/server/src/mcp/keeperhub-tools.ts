// The KeeperHub MCP tools: the agent-facing half of "compose, review, dry run, then
// execute exactly that". AttestPay decides what the card may spend; KeeperHub moves it.
//
//   keeperhub_dry_run           compose a payment and dry-run it through KeeperHub from the
//                               wallet that will execute it; returns a plan_id + the exact
//                               simulation. Nothing moves. `pay` with that plan_id executes
//                               the same signed bytes, or refuses.
//   keeperhub_execution_status  where a payment is in KeeperHub: run status, verified tx,
//                               per-node logs for workflow runs
//   keeperhub_audit_trail       KeeperHub's record for this card merged with AttestPay's
//                               own charge ledger, newest first
//
// Offered only when this deployment executes through KeeperHub: an agent is never shown
// a tool that can only answer "not configured".

import { z } from "zod";
import type { Address } from "viem";
import {
  RefusalError,
  atomsToUsdc,
  keeperhub,
  planSpend,
  usdcToAtoms,
  type CardRow,
  type SpendDeps,
} from "@attestpay/engine";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppDeps } from "../deps";
import { explorerTx, presentExecution, presentPlan } from "../keeperhub/routes";

type Run = (toolName: string, cardId: string, fn: () => Promise<unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

const iso = (sec: number | null | undefined): string | null => (sec ? new Date(sec * 1000).toISOString() : null);

export function registerKeeperHubTools(
  server: McpServer,
  deps: AppDeps,
  card: CardRow,
  run: Run,
  sd: SpendDeps,
  locked: <T>(fn: () => Promise<T>) => Promise<T>,
): void {
  const kh = deps.keeperhub;
  if (!kh?.config || deps.relayer.kind !== "keeperhub") return;
  const client = kh.client!;
  const store = kh.store;

  // -----------------------------------------------------------------------
  // keeperhub_dry_run
  // -----------------------------------------------------------------------
  if (card.terms.pay) {
    server.registerTool(
      "keeperhub_dry_run",
      {
        title: "Dry-run a payment through KeeperHub",
        description:
          "Compose a USDC payment from this card and dry-run it through KeeperHub without touching the chain. Checks the card's terms, signs the exact redemption, and simulates it from the KeeperHub wallet that will execute it. Returns a plan_id, the simulation (gas estimate, redeemer) and the budget left afterwards. Show the plan to your user, then call `pay` with plan_id to execute exactly this plan: nothing is re-derived at execution time. Plans expire (see expires_at).",
        inputSchema: {
          to: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("recipient address"),
          amount: z.string().regex(/^\d+(\.\d{1,6})?$/).describe('USDC amount, decimal string, e.g. "1.50"'),
          memo: z.string().max(280).optional().describe("what this payment is for"),
          idempotency_key: z.string().max(128).optional().describe("carried into the executed charge"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args: { to: string; amount: string; memo?: string; idempotency_key?: string }) =>
        run("keeperhub_dry_run", card.id, () =>
          locked(async () => {
            const plan = await planSpend(sd, card.id, {
              kind: "pay",
              mode: "pay",
              to: args.to as Address,
              amountAtoms: usdcToAtoms(args.amount),
              memo: args.memo,
              idempotencyKey: args.idempotency_key,
            });
            return {
              ...plan,
              expires_at: iso(plan.expires_at),
              simulation: { ...plan.simulation, simulated_at: iso(plan.simulation.simulated_at) },
              next: `call pay with plan_id "${plan.plan_id}" to execute exactly this plan through KeeperHub`,
            };
          }),
        ),
    );
  }

  // -----------------------------------------------------------------------
  // keeperhub_execution_status
  // -----------------------------------------------------------------------
  server.registerTool(
    "keeperhub_execution_status",
    {
      title: "KeeperHub execution status",
      description:
        "Look up how KeeperHub executed a payment from this card: pass the charge_id (from `card` recent charges or the audit trail), a plan_id, or a KeeperHub execution_id. Returns the run status, the verified on-chain transaction with an explorer link, retries, and per-node logs for workflow runs. `running`/`unconfirmed` means KeeperHub is still landing it (nonce management and gas re-pricing are its job): wait, do not pay again.",
      inputSchema: {
        charge_id: z.string().max(80).optional(),
        plan_id: z.string().max(80).optional(),
        execution_id: z.string().max(120).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args: { charge_id?: string; plan_id?: string; execution_id?: string }) =>
      run("keeperhub_execution_status", card.id, async () => {
        const subtree = new Set(deps.store.subtreeIds(card.id));
        let records: keeperhub.KeeperHubExecutionRow[] = [];
        let plan: keeperhub.SpendPlanRow | null = null;
        if (args.plan_id) {
          plan = store.getPlan(args.plan_id);
          if (!plan || !subtree.has(plan.card_id)) throw new RefusalError("card_not_found", "no such plan on this card");
          if (plan.charge_id) records = store.forCharge(plan.charge_id);
        } else if (args.charge_id) {
          const charge = deps.store.getCharge(args.charge_id);
          if (!charge || !subtree.has(charge.card_id)) throw new RefusalError("card_not_found", "no such charge on this card");
          records = store.forCharge(charge.id);
        } else if (args.execution_id) {
          const r = store.byExecutionId(args.execution_id);
          if (!r || !r.card_id || !subtree.has(r.card_id)) throw new RefusalError("card_not_found", "no such execution on this card");
          records = [r];
        } else {
          throw new RefusalError("invalid_terms", "pass one of charge_id, plan_id or execution_id");
        }

        const execution = [...records].reverse().find((r) => r.execution_id && (r.action === "execute" || r.action === "anchor"));
        let live: unknown = null;
        let logs: unknown = null;
        if (execution?.execution_id) {
          // refreshes the local record from KeeperHub's verified answer as a side effect
          if (execution.action === "execute") {
            await deps.relayer.getStatus(keeperhub.keeperhubRequestId(execution.surface, execution.execution_id));
          }
          try {
            if (execution.surface === "workflow") {
              const s = await client.workflowExecutionStatus(execution.execution_id);
              live = { status: s.status, progress: s.progress, transactions: s.transactionHashes };
              logs = (await client.workflowExecutionLogs(execution.execution_id)).logs.map((l) => ({
                node: l.nodeName,
                status: l.status,
                error: l.error,
                duration_ms: l.duration,
              }));
            } else {
              const d = await client.directExecutionStatus(execution.execution_id);
              live = {
                status: d.status,
                tx: d.transactionHash,
                receipts: d.receipts,
                retries: d.retryCount,
                gas_used_wei: d.gasUsedWei,
                estimated_cost_usd: d.estimatedCostUsd,
              };
            }
          } catch (e) {
            live = { error: `KeeperHub unreachable: ${e instanceof Error ? e.message : String(e)}` };
          }
        }
        const fresh = records.map((r) => store.get(r.id) ?? r);
        return {
          plan: plan ? presentPlan(plan) : null,
          records: fresh.map(presentExecution),
          execution: execution ? presentExecution(store.get(execution.id) ?? execution) : null,
          live,
          logs,
        };
      }),
  );

  // -----------------------------------------------------------------------
  // keeperhub_audit_trail
  // -----------------------------------------------------------------------
  server.registerTool(
    "keeperhub_audit_trail",
    {
      title: "KeeperHub audit trail",
      description:
        "This card's execution history: every KeeperHub dry run, workflow run and anchor for the card (and its sub-cards), merged with AttestPay's own charge ledger. Each charge shows the policy decision (AttestPay) next to the execution that moved it (KeeperHub), so the two failure domains stay distinguishable.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
      annotations: { readOnlyHint: true },
    },
    async (args: { limit?: number }) =>
      run("keeperhub_audit_trail", card.id, async () => {
        const limit = args.limit ?? 25;
        const ids = deps.store.subtreeIds(card.id);
        const records = store.forCards(ids, limit * 3);
        const charges = ids.flatMap((id) => deps.store.listCharges(id, limit)).sort((a, b) => b.created_at - a.created_at).slice(0, limit);
        return {
          executor: "keeperhub",
          charges: charges.map((ch) => {
            // records come newest-first; show each charge's lifecycle in order (dry run, then run)
            const kh = records.filter((r) => r.charge_id === ch.id).reverse();
            return {
              charge_id: ch.id,
              card_id: ch.card_id,
              kind: ch.kind,
              to: ch.to_addr,
              amount: atomsToUsdc(ch.amount_atoms),
              fee: atomsToUsdc(ch.fee_atoms),
              ledger_status: ch.status,
              tx: ch.tx_hash,
              tx_url: explorerTx(deps.relayer.chainId, ch.tx_hash),
              memo: ch.memo,
              at: iso(ch.created_at),
              keeperhub: kh.map((r) => ({ action: r.action, status: r.status, execution_id: r.execution_id, workflow: r.workflow_key, error: r.error })),
            };
          }),
          other_executions: records.filter((r) => !r.charge_id).slice(0, limit).map(presentExecution),
        };
      }),
  );
}
