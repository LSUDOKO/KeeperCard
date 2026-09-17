// payment-receipt-anchor: write an on-chain receipt for a confirmed KeeperCard payment
// through KeeperHub, from KeeperHub's wallet rather than this process's own key.
//
//   converge   already anchored (a crash after the tx landed)? reuse that receipt
//   dry run    simulate PaymentAnchor.anchorPayment from the KeeperHub wallet
//   execute    the payment-receipt-anchor workflow (or direct execution), with an
//              idempotency key per (charge, attempt generation): a retried sweep
//              replays the same run instead of anchoring twice
//   verify     KeeperHub's verified receipt gives the tx hash of the anchor
//
// The anchor lives on the settlement chain, so a receipt is written where the payment
// it describes happened and both are checkable on one explorer.

import { keccak256, toHex, type Address, type Hex } from "viem";
import { KeeperHubClient, TERMINAL_WORKFLOW_STATUSES } from "./client";
import type { KeeperHubConfig } from "./config";
import type { KeeperHubStore } from "./store";
import { emitKeeperHubExecutionFailed, keeperhubExecutionsTotal, traceKeeperHub } from "./telemetry";
import { PAYMENT_ANCHOR_ABI, PAYMENT_ANCHOR_EVENT_ABI } from "./workflows";

/** One confirmed payment, as PaymentAnchor records it. */
export type AnchorRequest = {
  /** KeeperCard charge id this receipt corresponds to. */
  chargeId: string;
  /** KeeperCard card id (the string id; hashed to bytes32 at the contract boundary). */
  cardId: string;
  /** The card tree's root delegator: where the USDC actually left from. */
  payer: Address;
  /** Payment recipient. */
  merchant: Address;
  /** USDC atoms (6 decimals). */
  amountAtoms: bigint;
  /** EVM chain id the USDC moved on (8453 Base, 84532 Base Sepolia). */
  sourceChainId: number;
  /** The payment's transaction hash on `sourceChainId`. */
  sourceTxHash: Hex;
  /** Unix seconds the payment confirmed. */
  paidAt: number;
  memo: string;
};

/** A receipt that could not be written. `retryable` separates "try the next sweep"
 * (unfunded wallet, simulator down, run still executing) from a contract revert. */
export class AnchorError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = "AnchorError";
  }
}

/** PaymentAnchor keys cards by bytes32; KeeperCard ids are uuids. */
export function cardIdToBytes32(cardId: string): Hex {
  return keccak256(toHex(cardId));
}

const IS_ANCHORED_ABI = [
  {
    type: "function",
    name: "isAnchored",
    stateMutability: "view",
    inputs: [
      { name: "sourceChainId", type: "uint256" },
      { name: "sourceTxHash", type: "bytes32" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

export type KeeperHubAnchorerOptions = {
  client: KeeperHubClient;
  config: KeeperHubConfig;
  store?: KeeperHubStore | null;
  anchorAddress: Address;
  /** chain the PaymentAnchor lives on (the settlement chain) */
  anchorChainId: number;
  /** already-anchored lookup; defaults to reading PaymentAnchor through KeeperHub */
  existingAnchor?: (req: AnchorRequest) => Promise<{ txHash: string | null; height: number | null } | null>;
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
  private readonly o: Required<Pick<KeeperHubAnchorerOptions, "waitMs" | "pollMs" | "now" | "sleep">> & KeeperHubAnchorerOptions;

  constructor(opts: KeeperHubAnchorerOptions) {
    this.o = {
      waitMs: 60_000,
      pollMs: 3_000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...opts,
    };
  }

  private generation(chargeId: string): number {
    // a definite failure is replayed by KeeperHub for 24h under the same key, so each
    // failed run moves the key to a new generation; in-flight runs keep theirs
    return (this.o.store?.forCharge(chargeId) ?? []).filter((r) => r.action === "anchor" && r.status === "failed").length;
  }

  /**
   * Has this payment already been receipted? Asked of the contract through KeeperHub,
   * so a crash between "the anchor landed" and "KeeperCard wrote it down" converges on
   * the receipt that exists instead of paying for a second one that would revert.
   */
  private async alreadyAnchored(req: AnchorRequest): Promise<{ txHash: string | null; height: number | null } | null> {
    if (this.o.existingAnchor) return this.o.existingAnchor(req);
    const read = await this.o.client
      .simulateContractCall({
        contractAddress: this.o.anchorAddress,
        chainId: this.o.anchorChainId,
        functionName: "isAnchored",
        functionArgs: JSON.stringify([String(req.sourceChainId), req.sourceTxHash]),
        abi: JSON.stringify(IS_ANCHORED_ABI),
      })
      .catch(() => null);
    const anchored = (read?.raw as { result?: unknown } | null | undefined)?.result === true;
    if (!anchored) return null;
    // find the receipt's own transaction; if the scan window misses it, the receipt
    // still exists and is reported with an unknown hash rather than re-written
    const events = await this.o.client
      .queryEvents({
        contractAddress: this.o.anchorAddress,
        chainId: this.o.anchorChainId,
        abi: JSON.stringify(PAYMENT_ANCHOR_EVENT_ABI),
        eventName: "PaymentAnchored",
        blockCount: 50_000,
      })
      .catch(() => null);
    const hit = events?.events.find((e) => String(e.args.sourceTxHash).toLowerCase() === req.sourceTxHash.toLowerCase());
    return { txHash: hit?.transactionHash ?? null, height: hit?.blockNumber ?? null };
  }

  async anchorPayment(req: AnchorRequest): Promise<{ txHash: string | null; height: number | null }> {
    return traceKeeperHub(
      "execute",
      { "keeperhub.workflow": "anchor", charge_id: req.chargeId, card_id: req.cardId, "keeperhub.chain_id": this.o.anchorChainId },
      async (span) => {
        const existing = await this.alreadyAnchored(req);
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
          throw new AnchorError(`KeeperHub dry run of anchorPayment failed: ${reason}`, retryable);
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
            const height = outcome.height ?? null;
            if (record) this.o.store!.update(record.id, { status: "completed", tx_hash: outcome.txHash as Hex, detail: { height, source_tx_hash: req.sourceTxHash } });
            return { txHash: outcome.txHash, height };
          }
          if (outcome.state === "failed") {
            if (record) this.o.store!.update(record.id, { status: "failed", error: outcome.reason });
            emitKeeperHubExecutionFailed({ executionId, workflow: "anchor", reason: outcome.reason, cardId: req.cardId, chargeId: req.chargeId });
            throw new AnchorError(`KeeperHub anchor run ${executionId} failed: ${outcome.reason}`, false);
          }
          if (this.o.now() >= deadline) {
            // not a failure: the next sweep polls the same run via the same key
            throw new AnchorError(`KeeperHub anchor run ${executionId} still executing`);
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
