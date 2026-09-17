// On-chain receipts: every confirmed KeeperCard payment gets a PaymentAnchor record,
// written by KeeperHub on the settlement chain.
//
// A charge ledger in a database is a claim; a PaymentAnchored event is a fact anyone can
// read. The receipt is deliberately downstream of the payment — it is queued when a
// charge confirms and written in the background, so a slow or failing receipt can never
// delay, fail, or roll back the payment it describes.
//
// State lives in the KeeperHub execution table (action = "anchor"), not in a table of
// its own: a receipt IS a KeeperHub execution, and one record keeps the two from
// disagreeing.

import type { Address } from "viem";
import type { Store } from "../store";
import { AnchorError, type AnchorRequest, type KeeperHubAnchorer } from "./anchor";
import type { KeeperHubExecutionRow, KeeperHubStore } from "./store";

export type ReceiptState = "anchored" | "anchoring" | "failed" | "pending" | "not_anchorable";

export type ReceiptView = {
  charge_id: string;
  state: ReceiptState;
  /** the receipt's own transaction on the anchor chain */
  anchor_tx: string | null;
  anchor_chain_id: number;
  /** the payment the receipt describes */
  payment_tx: string | null;
  payment_chain_id: number;
  execution_id: string | null;
  error: string | null;
  attempts: number;
};

/** The card tree's root delegator: the account the USDC actually left. */
export function payerForCard(store: Store, cardId: string): Address | null {
  const root = store.ancestorChain(cardId).at(-1);
  if (!root) return null;
  return store.getUser(root.user_id)?.address ?? null;
}

/** The anchor request for a confirmed charge, or null when there is nothing to anchor:
 * no transaction (an x402 purchase settled by the seller), no recipient, or no
 * resolvable funding account. */
export function anchorRequestFor(store: Store, chargeId: string, sourceChainId: number): AnchorRequest | null {
  const charge = store.getCharge(chargeId);
  if (!charge || charge.status !== "confirmed" || !charge.tx_hash || !charge.to_addr) return null;
  const payer = payerForCard(store, charge.card_id);
  if (!payer) return null;
  return {
    chargeId: charge.id,
    cardId: charge.card_id,
    payer,
    merchant: charge.to_addr,
    amountAtoms: charge.amount_atoms,
    sourceChainId,
    sourceTxHash: charge.tx_hash,
    paidAt: charge.created_at,
    memo: (charge.memo ?? "").slice(0, 140),
  };
}

export type ReceiptServiceOptions = {
  store: Store;
  executions: KeeperHubStore;
  anchorer: Pick<KeeperHubAnchorer, "anchorPayment">;
  /** chain payments settle on */
  paymentChainId: number;
  /** chain the PaymentAnchor lives on */
  anchorChainId: number;
  /** give up on a charge after this many failed attempts (default 5) */
  maxAttempts?: number;
  log?: (line: string) => void;
};

export class ReceiptService {
  private readonly inFlight = new Set<string>();
  private readonly maxAttempts: number;

  constructor(private readonly o: ReceiptServiceOptions) {
    this.maxAttempts = o.maxAttempts ?? 5;
  }

  private anchorRows(chargeId: string): KeeperHubExecutionRow[] {
    return this.o.executions.forCharge(chargeId).filter((r) => r.action === "anchor");
  }

  /** Where a charge's receipt stands, from the execution records alone. */
  view(chargeId: string): ReceiptView {
    const charge = this.o.store.getCharge(chargeId);
    const rows = this.anchorRows(chargeId);
    const done = rows.find((r) => r.status === "completed");
    const running = rows.find((r) => r.status === "running" || r.status === "pending" || r.status === "unconfirmed");
    const failures = rows.filter((r) => r.status === "failed");
    const anchorable = !!charge && charge.status === "confirmed" && !!charge.tx_hash && !!charge.to_addr;
    const state: ReceiptState = done
      ? "anchored"
      : running || this.inFlight.has(chargeId)
        ? "anchoring"
        : !anchorable
          ? "not_anchorable"
          : failures.length >= this.maxAttempts
            ? "failed"
            : "pending";
    const latest = done ?? running ?? failures.at(-1) ?? null;
    return {
      charge_id: chargeId,
      state,
      anchor_tx: done?.tx_hash ?? null,
      anchor_chain_id: this.o.anchorChainId,
      payment_tx: charge?.tx_hash ?? null,
      payment_chain_id: this.o.paymentChainId,
      execution_id: latest?.execution_id ?? null,
      error: state === "failed" || state === "pending" ? (failures.at(-1)?.error ?? null) : null,
      attempts: failures.length + (done ? 1 : 0),
    };
  }

  /** Anchor one charge now. Resolves to the resulting view; never throws. */
  async anchor(chargeId: string): Promise<ReceiptView> {
    const before = this.view(chargeId);
    if (before.state !== "pending") return before;
    const req = anchorRequestFor(this.o.store, chargeId, this.o.paymentChainId);
    if (!req) return before;
    this.inFlight.add(chargeId);
    try {
      const r = await this.o.anchorer.anchorPayment(req);
      this.o.log?.(`[receipts] charge ${chargeId} anchored${r.txHash ? ` (tx ${r.txHash})` : " (already on-chain)"}`);
    } catch (e) {
      const retryable = e instanceof AnchorError ? e.retryable : true;
      this.o.log?.(`[receipts] charge ${chargeId} not anchored${retryable ? " yet" : ""}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.inFlight.delete(chargeId);
    }
    return this.view(chargeId);
  }

  /** Fire-and-forget, for the charge-confirmed hook: the payment path never waits. */
  enqueue(chargeId: string): void {
    void this.anchor(chargeId).catch(() => {});
  }

  /** Retry whatever is still pending across the given cards. One at a time: receipts
   * share the KeeperHub wallet's nonce with payments, and payments come first. */
  async sweep(cardIds: string[], limit = 10): Promise<{ examined: number; anchored: number; pending: number }> {
    let examined = 0;
    let anchored = 0;
    let pending = 0;
    for (const cardId of cardIds) {
      for (const charge of this.o.store.listCharges(cardId, 50)) {
        if (examined >= limit) return { examined, anchored, pending };
        if (this.view(charge.id).state !== "pending") continue;
        examined++;
        const after = await this.anchor(charge.id);
        if (after.state === "anchored") anchored++;
        else if (after.state === "pending") pending++;
      }
    }
    return { examined, anchored, pending };
  }
}
