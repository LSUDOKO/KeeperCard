// The execution-layer seam. AttestPay's authorization layer (caveats, cards, refusals)
// builds a leaf-first permission context; an Executor gets it on-chain.
//
//   KeeperHubExecutor (default)  KeeperHub dry run -> reviewed plan -> exact execution,
//                                through the org's Turnkey wallet with KeeperHub's nonce
//                                management, gas strategy, retries and audit trail.
//   Relayer (legacy "1shot")     the original 1Shot relayer, kept as a rollback lane.
//
// The method names deliberately match the relayer's so the four redemption loops
// (spend, x402 settle, admin ops, fiat settlement) did not need a second code path.

import type { Address } from "viem";
import type { ChainId } from "./chains";
import type { Capabilities, EstimateResult, FeeData, RelayerStatus, RelayerTransaction } from "./relayer";
import type { Wire7702Auth } from "./types";

export type ExecutorKind = "keeperhub" | "1shot";

/** Why a redemption is being sent: selects the KeeperHub workflow that executes it. */
export type ExecutionPurpose = "pay" | "credit" | "settle" | "x402" | "admin";

export type SendOptions = {
  purpose?: ExecutionPurpose;
  cardId?: string;
  chargeId?: string;
};

export interface Executor {
  readonly chainId: ChainId;
  readonly kind: ExecutorKind;
  /** The address every leaf delegation must name as its delegate (msg.sender of redeem). */
  delegateAddress(): Promise<Address>;
  getCapabilities(): Promise<Capabilities>;
  getFeeData(token: Address): Promise<FeeData>;
  /** Dry run. `context` is the reviewed-plan token `send` must be given back verbatim. */
  estimate(transactions: RelayerTransaction[], authorizationList?: Wire7702Auth[]): Promise<EstimateResult>;
  /** Broadcast. Returns an execution/request id, never a tx hash. */
  send(
    transactions: RelayerTransaction[],
    context: string,
    authorizationList?: Wire7702Auth[],
    opts?: SendOptions,
  ): Promise<string>;
  getStatus(requestId: string): Promise<RelayerStatus>;
  waitForStatus(
    requestId: string,
    opts?: { timeoutMs?: number; intervalMs?: number },
  ): Promise<RelayerStatus & { timedOut: boolean }>;
}

/** Whether an executor's own status is on-chain truth (KeeperHub re-fetches every
 * receipt before reporting success), so the engine can skip its log-scan fallback. */
export function executorVerifiesReceipts(executor: Pick<Executor, "kind"> | { kind?: string }): boolean {
  return executor.kind === "keeperhub";
}
