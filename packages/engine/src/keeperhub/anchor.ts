// attestcoin-cross-chain-proof, leg 1: anchor a confirmed AttestPay payment on
// Ethereum Sepolia through KeeperHub instead of this process's own key.
//
//   converge   already anchored (a crash after the tx landed)? reuse that anchor
//   dry run    simulate PaymentAnchor.anchorPayment from the KeeperHub wallet
//   execute    the attestcoin-cross-chain-proof workflow (or direct execution), with
//              an idempotency key per (charge, attempt generation): a retried sweep
//              replays the same run instead of anchoring twice
//   verify     KeeperHub's verified receipt gives the tx hash + block height the
//              Creditcoin proof needs
//
// Leg 2 (AttestPayASC.verifyPayment on Creditcoin CC3) stays on AttestPay's direct
// path: KeeperHub's chain list does not include CC3.

import type { Address, Hex } from "viem";
import { AttestcoinError } from "../attestcoin/client";
import { cardIdToBytes32 } from "../attestcoin/config";
import type { AnchorRequest } from "../attestcoin/types";
import { KeeperHubClient, TERMINAL_WORKFLOW_STATUSES } from "./client";
import type { KeeperHubConfig } from "./config";
import type { KeeperHubStore } from "./store";
import { emitKeeperHubExecutionFailed, keeperhubExecutionsTotal, traceKeeperHub } from "./telemetry";
import { ETHEREUM_SEPOLIA_CHAIN_ID, PAYMENT_ANCHOR_ABI } from "./workflows";

export type KeeperHubAnchorerOptions = {
  client: KeeperHubClient;
  config: KeeperHubConfig;
  store?: KeeperHubStore | null;
  anchorAddress: Address;
  anchorChainId?: number;
  /** already-anchored lookup (AttestcoinClient.existingAnchor) */
  existingAnchor?: (req: AnchorRequest) => Promise<{ txHash: string; height: number } | null>;
  /** block height fallback when KeeperHub's receipt omits it (AttestcoinClient.sourceBlockOf) */
  blockOf?: (txHash: string) => Promise<number | null>;
  /** how long one sweep tick waits on KeeperHub before yielding (default 60s) */
  waitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export function anchorFunctionArgs(req: AnchorRequest): string {
  return JSON.stringify([
    cardIdToBytes32(req.cardId),
    req.payer,
    req.merchant,
    req.amountAtoms.toString(),
    String(req.sourceChainId),
    req.sourceTxHash,
    String(req.paidAt),
    req.memo ?? "",
  ]);
}

export class KeeperHubAnchorer {
  private readonly o: Required<Pick<KeeperHubAnchorerOptions, "waitMs" | "pollMs" | "now" | "sleep" | "anchorChainId">> &
    KeeperHubAnchorerOptions;

  constructor(opts: KeeperHubAnchorerOptions) {
    this.o = {
      waitMs: 60_000,
      pollMs: 3_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      anchorChainId: ETHEREUM_SEPOLIA_CHAIN_ID,
      ...opts,
    };
  }

  private generation(chargeId: string): number {
    // a definite failure is replayed by KeeperHub for 24h under the same key, so each
    // failed run moves the key to a new generation; in-flight runs keep theirs
    return (this.o.store?.forCharge(chargeId) ?? []).filter((r) => r.action === "anchor" && r.status === "failed").length;
  }

  async anchorPayment(req: AnchorRequest): Promise<{ txHash: string; height: number }> {
    return traceKeeperHub(
      "execute",
      { "keeperhub.workflow": "anchor", charge_id: req.chargeId, card_id: req.cardId, "keeperhub.chain_id": this.o.anchorChainId },
      async (span) => {
        const existing = await this.o.existingAnchor?.(req);
        if (existing) {
          span.setAttribute("keeperhub.anchor_preexisting", true);
          return existing;
        }

        const functionArgs = anchorFunctionArgs(req);
        const call = {
          contractAddress: this.o.anchorAddress,
          chainId: this.o.anchorChainId,
          functionName: "anchorPayment",
          functionArgs,
          abi: JSON.stringify(PAYMENT_ANCHOR_ABI),
          gasLimitMultiplier: this.o.config.gasLimitMultiplier,
        };

        const sim = await this.o.client.simulateContractCall(call);
        this.o.store?.record({
          execution_id: null,
          surface: "direct",
          workflow_key: "anchor",
          workflow_id: null,
          action: "dry_run",
          card_id: req.cardId,
          charge_id: req.chargeId,
          digest: null,
          status: sim.success ? "simulated" : "simulation_failed",
          tx_hash: null,
          chain_id: this.o.anchorChainId,
          error: sim.success ? null : (sim.revertReason ?? sim.error),
          detail: { gas_estimate: sim.gasEstimate, from: sim.from, purpose: "anchor" },
        });
        if (!sim.success) {
          const reason = sim.revertReason ?? sim.error ?? "simulation failed";
          // unfunded wallet / simulator down are transient; a contract revert is not
          const retryable = sim.code === "insufficient_balance" || sim.failureKind === "unavailable";
          throw new AttestcoinError("anchor", `KeeperHub dry run of anchorPayment failed: ${reason}`, retryable);
        }

        const key = `keepercard:anchor:${req.chargeId}:${this.generation(req.chargeId)}`;
        const workflowId = this.o.config.workflows.anchor;
        let executionId: string;
        let surface: "workflow" | "direct";
        if (workflowId) {
          const run = await this.o.client.executeWorkflow(
            workflowId,
            { functionArgs, chargeId: req.chargeId, cardId: req.cardId, sourceTxHash: req.sourceTxHash },
            key,
          );
          executionId = run.executionId;
          surface = "workflow";
        } else {
          const run = await this.o.client.executeContractCall(call, key);
          executionId = run.executionId;
          surface = "direct";
        }
        span.setAttribute("keeperhub.execution_id", executionId);
        keeperhubExecutionsTotal.add(1, { workflow: "anchor", surface });
        const record = this.o.store?.record({
          execution_id: executionId,
          surface,
          workflow_key: "anchor",
          workflow_id: workflowId,
          action: "anchor",
          card_id: req.cardId,
          charge_id: req.chargeId,
          digest: null,
          status: "running",
          tx_hash: null,
          chain_id: this.o.anchorChainId,
          error: null,
          detail: { idempotency_key: key, source_tx_hash: req.sourceTxHash },
        });

        const deadline = this.o.now() + this.o.waitMs;
        while (true) {
          const outcome = surface === "workflow" ? await this.pollWorkflow(executionId) : await this.pollDirect(executionId);
          if (outcome.state === "done") {
            const height = outcome.height ?? (await this.o.blockOf?.(outcome.txHash)) ?? null;
            if (height === null) {
              throw new AttestcoinError("anchor", `anchor ${outcome.txHash} landed but its block height is not readable yet`);
            }
            if (record) this.o.store!.update(record.id, { status: "completed", tx_hash: outcome.txHash as Hex, detail: { height } });
            return { txHash: outcome.txHash, height };
          }
          if (outcome.state === "failed") {
            if (record) this.o.store!.update(record.id, { status: "failed", error: outcome.reason });
            emitKeeperHubExecutionFailed({ executionId, workflow: "anchor", reason: outcome.reason, cardId: req.cardId, chargeId: req.chargeId });
            throw new AttestcoinError("anchor", `KeeperHub anchor run ${executionId} failed: ${outcome.reason}`);
          }
          if (this.o.now() >= deadline) {
            // not a failure: the next sweep polls the same run via the same key
            throw new AttestcoinError("anchor", `KeeperHub anchor run ${executionId} still executing`);
          }
          await this.o.sleep(this.o.pollMs);
        }
      },
    );
  }

  private async pollWorkflow(
    executionId: string,
  ): Promise<{ state: "done"; txHash: string; height: number | null } | { state: "failed"; reason: string } | { state: "running" }> {
    const s = await this.o.client.workflowExecutionStatus(executionId);
    const tx = s.transactionHashes.find((t) => t.verified !== false && t.receiptStatus !== "reverted") ?? s.transactionHashes[0];
    if (s.status === "success" && tx) return { state: "done", txHash: tx.hash, height: tx.blockNumber ?? null };
    if (TERMINAL_WORKFLOW_STATUSES.has(s.status)) {
      return { state: "failed", reason: typeof s.errorContext === "string" ? s.errorContext : s.status };
    }
    return { state: "running" };
  }

  private async pollDirect(
    executionId: string,
  ): Promise<{ state: "done"; txHash: string; height: number | null } | { state: "failed"; reason: string } | { state: "running" }> {
    const d = await this.o.client.directExecutionStatus(executionId);
    const receipt = d.receipts.find((r) => r.verified && r.receiptStatus !== "reverted");
    if (d.status === "completed" && (receipt?.hash ?? d.transactionHash)) {
      return { state: "done", txHash: (receipt?.hash ?? d.transactionHash)!, height: receipt?.blockNumber ?? null };
    }
    if (d.status === "failed") return { state: "failed", reason: d.error ?? "failed" };
    return { state: "running" };
  }
}
