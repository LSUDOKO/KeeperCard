// On-chain receipts. A receipt is downstream of the payment it describes, so the
// property that matters most is what it must NEVER do: delay, fail or double-write.

import { beforeAll, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { issueRootCard } from "../src/issuance";
import { AnchorError, KeeperHubStore, ReceiptService, anchorRequestFor, cardIdToBytes32, type AnchorRequest } from "../src/keeperhub";
import { Store } from "../src/store";

const NOW = 1_780_000_000;
const MERCHANT = "0xAc36D18d2315c8c1F6e93B9074D3C25e2DC14127" as Address;
const PAY_TX = `0x${"5a".repeat(32)}` as Hex;
const ANCHOR_TX = `0x${"7c".repeat(32)}` as Hex;
const user = privateKeyToAccount(generatePrivateKey());

beforeAll(() => {
  process.env.ATTESTPAY_MASTER_KEY = "d".repeat(64);
});

async function world(anchor: (req: AnchorRequest) => Promise<{ txHash: string | null; height: number | null }>) {
  const store = new Store(":memory:");
  store.upsertUser({ id: "u1", address: user.address });
  const executions = new KeeperHubStore(store.db);
  const card = await issueRootCard(
    { store, userSigner: user, now: () => NOW, revocationNonceOverride: 0n },
    { userId: "u1", name: "receipts", terms: { pay: { lifetime: { amount: "10" } } } },
  );
  const calls: AnchorRequest[] = [];
  const service = new ReceiptService({
    store,
    executions,
    paymentChainId: 8453,
    anchorChainId: 8453,
    maxAttempts: 2,
    anchorer: {
      anchorPayment: async (req) => {
        calls.push(req);
        const r = await anchor(req);
        // the real anchorer records its own execution row; mirror that
        executions.record({
          execution_id: `ex_${calls.length}`,
          surface: "workflow",
          workflow_key: "anchor",
          workflow_id: "wf_anchor",
          action: "anchor",
          card_id: req.cardId,
          charge_id: req.chargeId,
          digest: null,
          status: "completed",
          tx_hash: r.txHash as Hex | null,
          chain_id: 8453,
          error: null,
        });
        return r;
      },
    },
  });
  const charge = (status: "confirmed" | "pending", tx: Hex | null, to: Address | null = MERCHANT) => {
    const id = `ch_${Math.random().toString(36).slice(2, 10)}`;
    store.db
      .query(
        `INSERT INTO charges (id, card_id, idempotency_key, kind, to_addr, amount_atoms, fee_atoms, request_id, tx_hash, status, memo, created_at)
         VALUES ($id, $card, NULL, 'pay', $to, '1500000', '10000', NULL, $tx, $status, 'coffee', $at)`,
      )
      .run({ $id: id, $card: card.cardId, $to: to, $tx: tx, $status: status, $at: NOW });
    return id;
  };
  return { store, executions, service, calls, cardId: card.cardId, charge };
}

describe("anchorRequestFor", () => {
  test("describes the payment: root payer, merchant, amount and source transaction", async () => {
    const w = await world(async () => ({ txHash: ANCHOR_TX, height: 1 }));
    const req = anchorRequestFor(w.store, w.charge("confirmed", PAY_TX), 8453)!;
    expect(req.payer).toBe(user.address);
    expect(req.merchant).toBe(MERCHANT);
    expect(req.amountAtoms).toBe(1_500_000n);
    expect(req.sourceTxHash).toBe(PAY_TX);
    expect(req.sourceChainId).toBe(8453);
    expect(cardIdToBytes32(req.cardId)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("nothing to anchor without a confirmed on-chain transaction", async () => {
    const w = await world(async () => ({ txHash: ANCHOR_TX, height: 1 }));
    expect(anchorRequestFor(w.store, w.charge("pending", PAY_TX), 8453)).toBeNull();
    // an x402 purchase settled by the seller has no transaction of ours
    expect(anchorRequestFor(w.store, w.charge("confirmed", null), 8453)).toBeNull();
    expect(anchorRequestFor(w.store, "no_such_charge", 8453)).toBeNull();
  });
});

describe("ReceiptService", () => {
  test("anchors a confirmed payment once and reports both transactions", async () => {
    const w = await world(async () => ({ txHash: ANCHOR_TX, height: 42 }));
    const id = w.charge("confirmed", PAY_TX);
    expect(w.service.view(id).state).toBe("pending");

    const after = await w.service.anchor(id);
    expect(after.state).toBe("anchored");
    expect(after.anchor_tx).toBe(ANCHOR_TX);
    expect(after.payment_tx).toBe(PAY_TX);

    // a second attempt must not write a second receipt
    await w.service.anchor(id);
    expect(w.calls).toHaveLength(1);
  });

  test("a failing receipt never throws into the payment path, and stays retryable", async () => {
    const w = await world(async () => {
      throw new AnchorError("KeeperHub wallet has no gas");
    });
    const id = w.charge("confirmed", PAY_TX);
    // enqueue is what the charge-confirmed hook calls: it must be safe to fire and forget
    expect(() => w.service.enqueue(id)).not.toThrow();
    // while that attempt is in flight a second caller steps aside instead of double-anchoring
    expect(w.service.view(id).state).toBe("anchoring");
    await new Promise((r) => setTimeout(r, 5));
    // it failed, quietly: the charge is simply still waiting for its receipt
    expect(w.service.view(id).state).toBe("pending");
    const after = await w.service.anchor(id);
    expect(after.state).toBe("pending");
    expect(w.calls.length).toBe(2);
  });

  test("a charge with no transaction is not_anchorable, not an error and not retried", async () => {
    const w = await world(async () => ({ txHash: ANCHOR_TX, height: 1 }));
    const id = w.charge("confirmed", null);
    expect(w.service.view(id).state).toBe("not_anchorable");
    await w.service.anchor(id);
    expect(w.calls).toHaveLength(0);
  });

  test("the sweep anchors what is pending and leaves the rest alone", async () => {
    const w = await world(async () => ({ txHash: ANCHOR_TX, height: 1 }));
    const a = w.charge("confirmed", PAY_TX);
    const b = w.charge("confirmed", `0x${"6b".repeat(32)}` as Hex);
    w.charge("confirmed", null); // not anchorable
    w.charge("pending", `0x${"6c".repeat(32)}` as Hex); // not confirmed yet

    const r = await w.service.sweep([w.cardId]);
    expect(r).toEqual({ examined: 2, anchored: 2, pending: 0 });
    expect(w.service.view(a).state).toBe("anchored");
    expect(w.service.view(b).state).toBe("anchored");

    // nothing left to do on the next pass
    expect(await w.service.sweep([w.cardId])).toEqual({ examined: 0, anchored: 0, pending: 0 });
  });
});
