// KeeperHubExecutor: the execution layer under KeeperCard's delegations.
//
// estimate()  = KeeperHub dry run. The redemption is encoded ONCE, simulated with
//               `simulate: true` from the org's Turnkey wallet (the delegate every leaf
//               names), and the calldata digest becomes the plan token (`context`).
// send()      = executes the SAME bytes. With KEEPERHUB_DRY_RUN_REQUIRED (default on)
//               a digest that was not dry-run within the plan TTL is refused before
//               anything reaches KeeperHub: nothing is re-inferred at execution time.
//               Goes through the provisioned workflow (card-payment-redemption /
//               credit-line-draw-repay) when configured, else direct execution. Both
//               carry an Idempotency-Key derived from the digest, so a retried send can
//               only ever replay, never double-broadcast.
// getStatus() = KeeperHub's verified receipts are the truth (every hash is re-fetched
//               from the chain before a run reports success).

import type { Address, Hex } from "viem";
import { CHAIN_ID, CHAINS, DELEGATION_MANAGER, type ChainId } from "../chains";
import { EngineError } from "../errors";
import type { ExecutionPurpose, Executor, SendOptions } from "../executor";
import type { Capabilities, EstimateResult, FeeData, RelayerStatus, RelayerTransaction } from "../relayer";
import type { Wire7702Auth } from "../types";
import { encodeRedemption } from "./calldata";
import { KeeperHubClient, KeeperHubError, TERMINAL_WORKFLOW_STATUSES } from "./client";
import { DepegGuard } from "./treasury";
import type { KeeperHubConfig, KeeperHubWorkflowKey } from "./config";
import type { KeeperHubStore } from "./store";
import {
  emitKeeperHubExecutionFailed,
  keeperhubDryRunsTotal,
  keeperhubExecutionLatency,
  keeperhubExecutionsTotal,
  keeperhubRetriesTotal,
  traceKeeperHub,
} from "./telemetry";

const CONTEXT_PREFIX = "kh1";

export type PlanContext = { digest: Hex; simulatedAt: number; gasEstimate: string | null };

export function encodePlanContext(c: PlanContext): string {
  return [CONTEXT_PREFIX, c.digest, String(c.simulatedAt), c.gasEstimate ?? ""].join(".");
}

export function parsePlanContext(context: string | null | undefined): PlanContext | null {
  if (!context) return null;
  const [prefix, digest, at, gas] = context.split(".");
  if (prefix !== CONTEXT_PREFIX || !digest || !/^0x[0-9a-f]{64}$/i.test(digest)) return null;
  const simulatedAt = Number(at);
  if (!Number.isFinite(simulatedAt)) return null;
  return { digest: digest as Hex, simulatedAt, gasEstimate: gas ? gas : null };
}

export type KeeperHubRequestId = { surface: "workflow" | "direct"; executionId: string };

export function keeperhubRequestId(surface: "workflow" | "direct", executionId: string): string {
  return `kh:${surface === "workflow" ? "wf" : "dx"}:${executionId}`;
}

export function parseKeeperHubRequestId(requestId: string | null | undefined): KeeperHubRequestId | null {
  if (!requestId) return null;
  const m = /^kh:(wf|dx):(.+)$/.exec(requestId);
  if (!m) return null;
  return { surface: m[1] === "wf" ? "workflow" : "direct", executionId: m[2]! };
}

/**
 * Which provisioned workflow carries this spend.
 *
 * Every one of these is the same redemption on the same contract; what differs is whose
 * history it lands in. `x402` and `settle` get their own workflow so paid-API traffic
 * and Visa settlements are separable in KeeperHub's execution history — the audit trail
 * an operator actually reads. `credit` and `admin` ride `pay`.
 *
 * An agent-initiated payment at or above `guardedMinAtoms` goes through `guarded`, whose
 * risk check sits inside the workflow. Only `pay` is ever upgraded: a settlement or an
 * x402 charge was already authorised elsewhere, and refusing it late would strand it.
 */
export function workflowKeyFor(
  purpose: ExecutionPurpose | undefined,
  amount: { amountAtoms?: bigint; guardedMinAtoms?: bigint | null } = {},
): KeeperHubWorkflowKey {
  if (purpose === "settle") return "settle";
  if (purpose === "x402") return "x402";
  if (purpose === undefined || purpose === "pay") {
    const { amountAtoms, guardedMinAtoms } = amount;
    if (guardedMinAtoms != null && amountAtoms !== undefined && amountAtoms >= guardedMinAtoms) return "guarded";
  }
  return "pay";
}

/** Redemption workflows that fall back to `pay` when they are not provisioned. */
const REDEMPTION_FALLBACK: ReadonlySet<KeeperHubWorkflowKey> = new Set(["x402", "settle", "guarded"]);

export type Bootstrap7702 = (authorizationList: Wire7702Auth[], chainId: ChainId) => Promise<Hex>;

export type KeeperHubExecutorOptions = {
  config: KeeperHubConfig;
  client?: KeeperHubClient;
  store?: KeeperHubStore | null;
  chainId?: ChainId;
  /** wall clock in ms (test seam) */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** KeeperHub writes are ordinary transactions; an EIP-7702 upgrade (type-4) for a
   * brand-new account is submitted by this hook first, then the redemption proceeds
   * through KeeperHub. Absent = a typed error telling the operator what to set. */
  bootstrap7702?: Bootstrap7702 | null;
  /** Read KeeperHub's risk verdict during the dry run. Advisory, and on by default;
   * set false to skip the extra call. */
  assessRisk?: boolean;
};

export class KeeperHubExecutor implements Executor {
  readonly kind = "keeperhub" as const;
  readonly chainId: ChainId;
  readonly client: KeeperHubClient;
  readonly config: KeeperHubConfig;
  private readonly assessRisk: boolean;
  private readonly depeg: DepegGuard;
  private readonly store: KeeperHubStore | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly bootstrap7702: Bootstrap7702 | null;
  private wallet: Address | null;

  constructor(opts: KeeperHubExecutorOptions) {
    this.config = opts.config;
    this.client = opts.client ?? new KeeperHubClient(opts.config);
    this.store = opts.store ?? null;
    this.chainId = opts.chainId ?? CHAIN_ID;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.bootstrap7702 = opts.bootstrap7702 ?? null;
    this.assessRisk = opts.assessRisk ?? true;
    this.depeg = new DepegGuard(this.client, opts.config.depegFloor, { now: this.now });
    this.wallet = opts.config.walletAddress;
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }

  // ---------------------------------------------------------------------------
  // identity + fees
  // ---------------------------------------------------------------------------

  async delegateAddress(): Promise<Address> {
    if (this.wallet) return this.wallet;
    let resolved: Address | null;
    try {
      resolved = await this.client.walletAddress();
    } catch (e) {
      throw new EngineError("keeperhub", `could not resolve the KeeperHub org wallet: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resolved) {
      throw new EngineError(
        "keeperhub",
        "the KeeperHub organization has no web3 wallet; create one at app.keeperhub.com or set KEEPERHUB_WALLET_ADDRESS",
      );
    }
    this.wallet = resolved;
    return resolved;
  }

  async getCapabilities(): Promise<Capabilities> {
    const wallet = await this.delegateAddress();
    return {
      targetAddress: wallet,
      feeCollector: wallet,
      tokens: [{ address: CHAINS[this.chainId].usdc, decimals: 6, symbol: "USDC" }],
    };
  }

  /** The "fee" is a USDC gas reimbursement to the KeeperHub wallet that fronts the
   * ETH. It rides the same redemption, so it is covered by the card's own caveats and
   * doubles as the per-spend on-chain fingerprint the engine already relies on. */
  async getFeeData(_token: Address): Promise<FeeData> {
    const wallet = await this.delegateAddress();
    return {
      minFee: this.config.gasFeeUsdc,
      rate: 1,
      gasPrice: "0",
      expiry: this.nowSec() + this.config.planTtlSeconds,
      feeCollector: wallet,
      targetAddress: wallet,
      context: "keeperhub",
    };
  }

  // ---------------------------------------------------------------------------
  // dry run
  // ---------------------------------------------------------------------------

  async estimate(transactions: RelayerTransaction[], authorizationList?: Wire7702Auth[]): Promise<EstimateResult> {
    if (authorizationList?.length) {
      if (!this.bootstrap7702) {
        return {
          success: false,
          requiredPaymentAmount: null,
          context: null,
          error:
            "smart_account_not_upgraded: this wallet has no EIP-7702 code yet and KeeperHub submits ordinary transactions; set ATTESTPAY_7702_SPONSOR_PK to let KeeperCard submit the one-time upgrade",
          raw: null,
        };
      }
      await this.bootstrap7702(authorizationList, this.chainId);
    }

    // Cards are denominated in USDC. When Chainlink says USDC is off its peg, every
    // budget means something other than what its owner approved, so the dry run refuses
    // before anything is signed for. A feed that cannot be read refuses nothing.
    const depegged = await this.depeg.refusal();
    if (depegged) {
      keeperhubDryRunsTotal.add(1, { outcome: "depegged" });
      return { success: false, requiredPaymentAmount: null, context: null, error: depegged, raw: null };
    }

    const encoded = encodeRedemption(transactions);
    return traceKeeperHub(
      "dry_run",
      {
        "keeperhub.digest": encoded.digest,
        "keeperhub.chain_id": this.chainId,
        "keeperhub.execution_count": encoded.executionCount,
      },
      async (span) => {
        let sim;
        try {
          sim = await this.client.simulateContractCall({
            contractAddress: DELEGATION_MANAGER,
            chainId: this.chainId,
            data: encoded.data,
            gasLimitMultiplier: this.config.gasLimitMultiplier,
          });
        } catch (e) {
          keeperhubDryRunsTotal.add(1, { outcome: "error" });
          this.store?.record({
            execution_id: null,
            surface: "direct",
            workflow_key: null,
            workflow_id: null,
            action: "dry_run",
            card_id: null,
            charge_id: null,
            digest: encoded.digest,
            status: "simulation_failed",
            tx_hash: null,
            chain_id: this.chainId,
            error: e instanceof Error ? e.message : String(e),
          });
          throw new EngineError("keeperhub", `dry run unavailable: ${e instanceof Error ? e.message : String(e)}`, e);
        }

        const record = (status: "simulated" | "simulation_failed", error: string | null) =>
          this.store?.record({
            execution_id: null,
            surface: "direct",
            workflow_key: null,
            workflow_id: null,
            action: "dry_run",
            card_id: null,
            charge_id: null,
            digest: encoded.digest,
            status,
            tx_hash: null,
            chain_id: this.chainId,
            error,
            detail: {
              from: sim.from,
              to: sim.to,
              gas_estimate: sim.gasEstimate,
              would_revert: sim.wouldRevert,
              revert_reason: sim.revertReason,
              execution_count: encoded.executionCount,
            },
          });

        if (sim.code === "insufficient_balance") {
          keeperhubDryRunsTotal.add(1, { outcome: "unfunded" });
          record("simulation_failed", sim.error ?? "insufficient_balance");
          throw new EngineError(
            "keeperhub",
            `the KeeperHub wallet ${sim.from ?? ""} cannot cover gas on chain ${this.chainId}: ${sim.error ?? "insufficient balance"}`,
          );
        }
        if (sim.failureKind === "unavailable") {
          keeperhubDryRunsTotal.add(1, { outcome: "unavailable" });
          record("simulation_failed", sim.error ?? "simulator unavailable");
          throw new EngineError("keeperhub", `KeeperHub simulator unavailable: ${sim.error ?? "try again"}`);
        }
        if (!sim.success) {
          keeperhubDryRunsTotal.add(1, { outcome: "revert" });
          const reason = sim.revertReason ?? sim.error ?? "simulation failed";
          span.setAttribute("keeperhub.revert_reason", reason);
          record("simulation_failed", reason);
          return { success: false, requiredPaymentAmount: null, context: null, error: reason, raw: sim.raw };
        }

        keeperhubDryRunsTotal.add(1, { outcome: "ok" });
        if (sim.gasEstimate) span.setAttribute("keeperhub.gas_estimate", sim.gasEstimate);

        // Advisory only, and never fatal: a risk service that is down must not take
        // payments down with it, so a failure here is recorded and the plan proceeds.
        const risk = this.assessRisk
          ? await this.client
              .assessRisk({
                calldata: encoded.data,
                chainId: this.chainId,
                contractAddress: DELEGATION_MANAGER,
                senderAddress: sim.from ?? undefined,
              })
              .catch(() => null)
          : null;
        if (risk?.level) {
          span.setAttribute("keeperhub.risk_level", risk.level);
          span.setAttribute("keeperhub.risk_advisory", risk.advisory);
          if (risk.score !== null) span.setAttribute("keeperhub.risk_score", risk.score);
        }

        record("simulated", null);
        const context = encodePlanContext({
          digest: encoded.digest,
          simulatedAt: this.nowSec(),
          gasEstimate: sim.gasEstimate,
        });
        return { success: true, requiredPaymentAmount: null, context, error: null, raw: sim.raw, risk };
      },
    );
  }

  // ---------------------------------------------------------------------------
  // execution
  // ---------------------------------------------------------------------------

  async send(
    transactions: RelayerTransaction[],
    context: string,
    _authorizationList?: Wire7702Auth[],
    opts: SendOptions = {},
  ): Promise<string> {
    const encoded = encodeRedemption(transactions);
    const plan = parsePlanContext(context);

    if (this.config.dryRunRequired) {
      if (!plan || plan.digest.toLowerCase() !== encoded.digest.toLowerCase()) {
        throw new EngineError(
          "keeperhub_dry_run_required",
          "refusing to execute a redemption that was not dry-run: the bytes differ from the reviewed plan",
        );
      }
      if (this.nowSec() - plan.simulatedAt > this.config.planTtlSeconds) {
        throw new EngineError(
          "keeperhub_dry_run_required",
          `the reviewed plan expired (dry run is older than ${this.config.planTtlSeconds}s); dry-run again`,
        );
      }
      const sim = this.store?.latestSimulation(encoded.digest);
      if (this.store && sim?.status !== "simulated") {
        throw new EngineError("keeperhub_dry_run_required", "no successful KeeperHub dry run is on record for this plan");
      }
    }

    const guardedMinAtoms = this.config.guardedMinUsdc ? BigInt(Math.round(Number(this.config.guardedMinUsdc) * 1e6)) : null;
    let workflowKey = workflowKeyFor(opts.purpose, { amountAtoms: opts.amountAtoms, guardedMinAtoms });
    // x402, settle and guarded are the pay redemption with different bookkeeping, so an
    // un-provisioned one falls back to `pay` rather than dropping to direct execution:
    // the redemption still runs through a reviewed workflow either way.
    let workflowId = this.config.workflows[workflowKey];
    if (!workflowId && REDEMPTION_FALLBACK.has(workflowKey)) {
      workflowKey = "pay";
      workflowId = this.config.workflows.pay;
    }
    const idempotencyKey = `keepercard:redeem:${this.chainId}:${encoded.digest}`;

    return traceKeeperHub(
      "execute",
      {
        "keeperhub.digest": encoded.digest,
        "keeperhub.workflow": workflowKey,
        "keeperhub.surface": workflowId ? "workflow" : "direct",
        "keeperhub.chain_id": this.chainId,
        ...(opts.cardId ? { card_id: opts.cardId } : {}),
        ...(opts.chargeId ? { charge_id: opts.chargeId } : {}),
      },
      async (span) => {
        try {
          if (workflowId) {
            const run = await this.client.executeWorkflow(
              workflowId,
              {
                functionArgs: encoded.functionArgs,
                // the raw calldata, for workflows that inspect it (guarded's risk node)
                calldata: encoded.data,
                digest: encoded.digest,
                chainId: String(this.chainId),
                delegationManager: DELEGATION_MANAGER,
                purpose: opts.purpose ?? "pay",
                cardId: opts.cardId ?? "",
                chargeId: opts.chargeId ?? "",
              },
              idempotencyKey,
            );
            span.setAttribute("keeperhub.execution_id", run.executionId);
            span.setAttribute("keeperhub.idempotent_replay", run.idempotentReplay);
            keeperhubExecutionsTotal.add(1, { workflow: workflowKey, surface: "workflow" });
            this.store?.record({
              execution_id: run.executionId,
              surface: "workflow",
              workflow_key: workflowKey,
              workflow_id: workflowId,
              action: "execute",
              card_id: opts.cardId ?? null,
              charge_id: opts.chargeId ?? null,
              digest: encoded.digest,
              status: "running",
              tx_hash: null,
              chain_id: this.chainId,
              error: null,
              detail: { purpose: opts.purpose ?? "pay", idempotency_key: idempotencyKey, replay: run.idempotentReplay },
            });
            return keeperhubRequestId("workflow", run.executionId);
          }

          const run = await this.client.executeContractCall(
            {
              contractAddress: DELEGATION_MANAGER,
              chainId: this.chainId,
              data: encoded.data,
              gasLimitMultiplier: this.config.gasLimitMultiplier,
            },
            idempotencyKey,
          );
          span.setAttribute("keeperhub.execution_id", run.executionId);
          keeperhubExecutionsTotal.add(1, { workflow: workflowKey, surface: "direct" });
          this.store?.record({
            execution_id: run.executionId,
            surface: "direct",
            workflow_key: workflowKey,
            workflow_id: null,
            action: "execute",
            card_id: opts.cardId ?? null,
            charge_id: opts.chargeId ?? null,
            digest: encoded.digest,
            status: run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : run.status,
            tx_hash: run.transactionHash,
            chain_id: this.chainId,
            error: run.error,
            detail: {
              purpose: opts.purpose ?? "pay",
              idempotency_key: idempotencyKey,
              replay: run.idempotentReplay,
              transaction_link: run.transactionLink,
            },
          });
          if (run.status === "failed") {
            emitKeeperHubExecutionFailed({
              executionId: run.executionId,
              workflow: workflowKey,
              reason: run.error ?? "failed",
              cardId: opts.cardId,
              chargeId: opts.chargeId,
            });
          }
          return keeperhubRequestId("direct", run.executionId);
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          emitKeeperHubExecutionFailed({
            executionId: null,
            workflow: workflowKey,
            reason,
            cardId: opts.cardId,
            chargeId: opts.chargeId,
          });
          if (e instanceof KeeperHubError && e.code === "idempotency_conflict") {
            throw new EngineError("keeperhub", `KeeperHub refused a conflicting replay of plan ${encoded.digest}: ${reason}`, e);
          }
          throw new EngineError("keeperhub", `execution rejected: ${reason}`, e);
        }
      },
    );
  }

  // ---------------------------------------------------------------------------
  // status
  // ---------------------------------------------------------------------------

  async getStatus(requestId: string): Promise<RelayerStatus> {
    const id = parseKeeperHubRequestId(requestId);
    if (!id) return { status: null, txHash: null, raw: null };
    return traceKeeperHub(
      "execution_poll",
      { "keeperhub.execution_id": id.executionId, "keeperhub.surface": id.surface },
      async (span) => {
        try {
          const st = id.surface === "workflow" ? await this.workflowStatus(id.executionId) : await this.directStatus(id.executionId);
          span.setAttribute("keeperhub.status", String(st.status));
          return st;
        } catch (e) {
          // a transport blip is "unknown", never "failed": the tx may still land
          return { status: null, txHash: null, raw: e instanceof Error ? e.message : String(e) };
        }
      },
    );
  }

  private async workflowStatus(executionId: string): Promise<RelayerStatus> {
    const s = await this.client.workflowExecutionStatus(executionId);
    const verified = s.transactionHashes.find((t) => t.verified !== false && t.receiptStatus !== "reverted");
    const anyHash = s.transactionHashes[0]?.hash ?? null;
    if (s.status === "success") {
      const hash = verified?.hash ?? anyHash;
      // A redemption run that finished without broadcasting is NOT a payment. It happens
      // when a Condition routes around the write — guarded-card-payment's risk check
      // refusing — and reporting it as confirmed would book a charge that never moved.
      const row = this.store?.byExecutionId(executionId);
      if (!hash && row?.action === "execute") {
        const reason = "the workflow finished without broadcasting a transaction (a Condition refused the write)";
        this.settleRecord(executionId, "failed", null, reason, { node_statuses: s.nodeStatuses });
        emitKeeperHubExecutionFailed({ reason, executionId, workflow: row.workflow_key ?? "pay", cardId: row.card_id, chargeId: row.charge_id });
        return { status: 500, txHash: null, raw: s };
      }
      this.settleRecord(executionId, "completed", hash, null, { node_statuses: s.nodeStatuses });
      return { status: 200, txHash: hash, raw: s };
    }
    if (TERMINAL_WORKFLOW_STATUSES.has(s.status)) {
      const reason = typeof s.errorContext === "string" ? s.errorContext : JSON.stringify(s.errorContext ?? s.status);
      this.settleRecord(executionId, "failed", anyHash, reason, { node_statuses: s.nodeStatuses });
      return { status: 500, txHash: anyHash, raw: s };
    }
    const row = this.store?.byExecutionId(executionId);
    if (row) {
      this.store!.update(row.id, {
        status: s.status === "unconfirmed" ? "unconfirmed" : "running",
        ...(anyHash ? { tx_hash: anyHash } : {}),
      });
    }
    return { status: 110, txHash: anyHash, raw: s };
  }

  private async directStatus(executionId: string): Promise<RelayerStatus> {
    const d = await this.client.directExecutionStatus(executionId);
    if (d.retryCount) keeperhubRetriesTotal.add(d.retryCount, { surface: "direct" });
    const verified = d.receipts.find((r) => r.verified && r.receiptStatus !== "reverted");
    if (d.status === "completed") {
      const hash = verified?.hash ?? d.transactionHash;
      this.settleRecord(executionId, "completed", hash, null, {
        gas_used_wei: d.gasUsedWei,
        estimated_cost_usd: d.estimatedCostUsd,
        sponsored: d.sponsored,
        retry_count: d.retryCount,
        transaction_link: d.transactionLink,
      });
      return { status: 200, txHash: hash, raw: d };
    }
    if (d.status === "failed") {
      this.settleRecord(executionId, "failed", d.transactionHash, d.error ?? "failed", { retry_count: d.retryCount });
      return { status: 500, txHash: d.transactionHash, raw: d };
    }
    const row = this.store?.byExecutionId(executionId);
    if (row) this.store!.update(row.id, { status: d.status === "unconfirmed" ? "unconfirmed" : "running" });
    return { status: 110, txHash: d.transactionHash, raw: d };
  }

  private settleRecord(
    executionId: string,
    status: "completed" | "failed",
    txHash: Hex | null,
    error: string | null,
    detail: Record<string, unknown>,
  ): void {
    const row = this.store?.byExecutionId(executionId);
    if (!row || row.status === "completed" || row.status === "failed") return;
    this.store!.update(row.id, { status, ...(txHash ? { tx_hash: txHash } : {}), ...(error ? { error } : {}), detail });
    const workflow = row.workflow_key ?? "pay";
    keeperhubExecutionLatency.record(Math.max(0, this.now() - row.created_at * 1000), { workflow, status });
    if (status === "failed") {
      emitKeeperHubExecutionFailed({
        executionId,
        workflow,
        reason: error ?? "failed",
        cardId: row.card_id,
        chargeId: row.charge_id,
      });
    }
  }

  async waitForStatus(
    requestId: string,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<RelayerStatus & { timedOut: boolean }> {
    const deadline = this.now() + (opts.timeoutMs ?? 90_000);
    const interval = opts.intervalMs ?? 2_000;
    let last: RelayerStatus = { status: null, txHash: null, raw: null };
    while (this.now() < deadline) {
      last = await this.getStatus(requestId);
      if (last.status === 200 || last.status === 500) return { ...last, timedOut: false };
      await this.sleep(interval);
    }
    return { ...last, timedOut: true };
  }
}
