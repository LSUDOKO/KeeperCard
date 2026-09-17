// The KeeperHub MCP tools: the agent-facing half of "compose, review, dry run, then
// execute exactly that". KeeperCard decides what the card may spend; KeeperHub moves it.
//
//   keeperhub_dry_run           compose a payment and dry-run it through KeeperHub from the
//                               wallet that will execute it; returns a plan_id + the exact
//                               simulation. Nothing moves. `pay` with that plan_id executes
//                               the same signed bytes, or refuses.
//   keeperhub_execution_status  where a payment is in KeeperHub: run status, verified tx,
//                               per-node logs for workflow runs
//   payment_receipt             the on-chain receipt KeeperHub wrote for a payment: both
//                               transactions, each independently checkable
//   treasury_status             the wallets and reference prices payments depend on, read
//                               live through KeeperHub
//   keeperhub_audit_trail       KeeperHub's record for this card merged with KeeperCard's
//                               own charge ledger, newest first
//
// Offered only when this deployment executes through KeeperHub: an agent is never shown
// a tool that can only answer "not configured".

import { z } from "zod";
import type { Address } from "viem";
import {
  CHAIN_ID,
  CHAINS,
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
import { explorerTx, presentExecution, presentPlan, presentReceipt, presentRisk } from "../keeperhub/routes";

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
          "Compose a USDC payment from this card and dry-run it through KeeperHub without touching the chain. Checks the card's terms, signs the exact redemption, and simulates it from the KeeperHub wallet that will execute it. Returns a plan_id, the simulation (gas estimate, redeemer), KeeperHub's risk read on the calldata, and the budget left afterwards. Show the plan to your user, then call `pay` with plan_id to execute exactly this plan: nothing is re-derived at execution time. Plans expire (see expires_at).\n\nOn `risk`: `level` is low/medium/high/critical. When `advisory` is true the assessor did NOT reach a verdict (its backend failed and it returned a fail-closed default) — report it as unavailable rather than as a finding, and do not refuse the payment on it. When `advisory` is false, a high or critical level is a real finding: surface `reasoning` and `factors` to your user and get confirmation before calling `pay`.",
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
              risk: presentRisk(plan.risk),
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
  // payment_receipt
  // -----------------------------------------------------------------------
  if (kh.receipts) {
    const receipts = kh.receipts;
    server.registerTool(
      "payment_receipt",
      {
        title: "On-chain receipt for a payment",
        description:
          "The on-chain receipt for a payment this card made. After a payment confirms, KeeperHub writes a PaymentAnchor record on the same chain: card, payer, merchant, amount and the payment's transaction hash, as a public append-only event. Returns both transactions with explorer links — the payment itself and the receipt that records it — so a counterparty can check the payment without trusting KeeperCard. With no charge_id, lists the receipts for this card's recent payments. `state` is anchored / anchoring / pending / failed / not_anchorable (an x402 purchase settled by the seller has no transaction of ours to anchor). A receipt is written in the background: `pending` right after a payment is normal, not an error.",
        inputSchema: {
          charge_id: z.string().max(128).optional().describe("a charge id from `card` or `pay`; omit to list recent receipts"),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (args: { charge_id?: string }) =>
        run("payment_receipt", card.id, async () => {
          const ids = new Set(sd.store.subtreeIds(card.id));
          if (args.charge_id) {
            const charge = sd.store.getCharge(args.charge_id);
            if (!charge || !ids.has(charge.card_id)) throw new RefusalError("card_not_found", "no such charge on this card");
            return { ...presentReceipt(receipts.view(charge.id)), amount: atomsToUsdc(charge.amount_atoms), memo: charge.memo, anchor_contract: kh.config!.receiptAnchorAddress };
          }
          const items = [...ids]
            .flatMap((id) => sd.store.listCharges(id, 20))
            .filter((ch) => ch.status === "confirmed")
            .slice(0, 20)
            .map((ch) => ({ ...presentReceipt(receipts.view(ch.id)), amount: atomsToUsdc(ch.amount_atoms), memo: ch.memo }));
          return { anchor_contract: kh.config!.receiptAnchorAddress, receipts: items };
        }),
    );
  }

  // -----------------------------------------------------------------------
  // treasury_status
  // -----------------------------------------------------------------------
  server.registerTool(
    "treasury_status",
    {
      title: "Execution-layer health",
      description:
        "Whether a payment can land right now, read live through KeeperHub: the gas and USDC balance of the wallet that executes payments, and Chainlink's USDC/USD and ETH/USD reference prices. `usdc_depegged: true` means payments are being refused because USDC reads below the floor; `gas_low: true` means the executing wallet may fail KeeperHub's gas preflight. A null figure means that read failed — treat it as unknown, never as zero. Call this when a payment fails for a reason that is not about the card's own terms.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      run("treasury_status", card.id, async () => {
        const orgWallet = (kh.config!.walletAddress ?? (await deps.relayer.delegateAddress().catch(() => null))) as Address | null;
        const t = await keeperhub.readTreasury({
          client,
          chainId: CHAIN_ID,
          usdc: CHAINS[CHAIN_ID].usdc,
          orgWallet,
          depegFloor: kh.config!.depegFloor,
        });
        return {
          chain: CHAINS[CHAIN_ID].name,
          executing_wallet: t.org_wallet
            ? {
                address: t.org_wallet.address,
                gas_eth: t.org_wallet.gas_wei === null ? null : (Number(t.org_wallet.gas_wei) / 1e18).toFixed(8),
                usdc: t.org_wallet.usdc_atoms === null ? null : atomsToUsdc(BigInt(t.org_wallet.usdc_atoms)),
                gas_low: t.org_wallet.gas_low,
              }
            : null,
          usdc_usd: t.usdc_usd,
          eth_usd: t.eth_usd,
          usdc_depegged: t.usdc_depegged,
          depeg_floor: t.depeg_floor,
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
        "This card's execution history: every KeeperHub dry run, workflow run and anchor for the card (and its sub-cards), merged with KeeperCard's own charge ledger. Each charge shows the policy decision (KeeperCard) next to the execution that moved it (KeeperHub), so the two failure domains stay distinguishable.",
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
