// Checking AttestPay's own anchor records against the chain that holds them.
//
// Every other surface in this repo reports what AttestPay believes: the local
// keeperhub_executions table says an anchor landed, and the dashboard repeats it. That
// belief comes from KeeperHub's reply, which is good evidence, but it is still a record
// of what a service said rather than of what the chain contains.
//
// This module reads the `PaymentAnchored` events back through KeeperHub's RPC fleet and
// lines them up against the local rows. Three outcomes matter, and they are deliberately
// kept apart:
//
//   matched   — a local row and an on-chain event for the same transaction
//   unwitnessed — a local row claiming success with no event in the scanned window.
//                 NOT proof of a lie: the window may simply not reach far enough back.
//   unrecorded  — an event on-chain that AttestPay has no row for, which is the more
//                 interesting direction (a run whose result never made it home).
//
// The window is finite, so "unwitnessed" is reported with the range that was scanned
// and never described as missing outright.

import type { Address, Hex } from "viem";
import type { KeeperHubClient, DecodedEvent } from "./client";
import type { KeeperHubStore } from "./store";
import { PAYMENT_ANCHOR_EVENT_ABI, ETHEREUM_SEPOLIA_CHAIN_ID } from "./workflows";

export type AnchorWitness = {
  tx_hash: Hex | null;
  block_number: number | null;
  card_id: string | null;
  payer: string | null;
  merchant: string | null;
  /** USDC atoms as a decimal string, as the event carries it */
  amount: string | null;
  source_chain_id: string | null;
  source_tx_hash: string | null;
  memo: string | null;
};

export type AttestationReport = {
  /** the block range actually scanned; an absent anchor older than this is not missing */
  from_block: number | null;
  to_block: number | null;
  chain_id: number;
  contract: Address;
  matched: AnchorWitness[];
  /** local rows that claim a landed anchor with no event in the window */
  unwitnessed: Array<{ tx_hash: string | null; execution_id: string | null; charge_id: string | null; created_at: string }>;
  /** on-chain anchors with no local row: a run whose result never came back */
  unrecorded: AnchorWitness[];
  /** null when the chain read failed — an empty report would read as "all clear" */
  error: string | null;
};

function witness(e: DecodedEvent): AnchorWitness {
  const a = e.args;
  const s = (k: string): string | null => (a[k] === undefined || a[k] === null ? null : String(a[k]));
  return {
    tx_hash: e.transactionHash,
    block_number: e.blockNumber,
    card_id: s("cardId"),
    payer: s("payer"),
    merchant: s("merchant"),
    amount: s("amount"),
    source_chain_id: s("sourceChainId"),
    source_tx_hash: s("sourceTxHash"),
    memo: s("memo"),
  };
}

/**
 * Reconcile local anchor records against `PaymentAnchored` events on the anchor chain.
 *
 * `blockCount` bounds the scan; anything older simply is not looked at, which is why the
 * report carries the window rather than implying it covered all of history.
 */
export async function attestAnchors(opts: {
  client: KeeperHubClient;
  store: KeeperHubStore;
  anchorAddress: Address;
  anchorChainId?: number;
  blockCount?: number;
  /** how many local anchor rows to check (newest first) */
  limit?: number;
}): Promise<AttestationReport> {
  const chainId = opts.anchorChainId ?? ETHEREUM_SEPOLIA_CHAIN_ID;
  const base: AttestationReport = {
    from_block: null,
    to_block: null,
    chain_id: chainId,
    contract: opts.anchorAddress,
    matched: [],
    unwitnessed: [],
    unrecorded: [],
    error: null,
  };

  let result;
  try {
    result = await opts.client.queryEvents({
      contractAddress: opts.anchorAddress,
      chainId,
      abi: JSON.stringify(PAYMENT_ANCHOR_EVENT_ABI),
      eventName: "PaymentAnchored",
      blockCount: opts.blockCount ?? 6500,
    });
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
  if (!result.success) return { ...base, error: result.error ?? "event query failed" };

  const onChain = new Map<string, AnchorWitness>();
  for (const e of result.events) {
    if (e.transactionHash) onChain.set(e.transactionHash.toLowerCase(), witness(e));
  }

  // local rows that reached the chain: an anchor with a hash and a terminal-success status
  const local = opts.store
    .recent(opts.limit ?? 200, { action: "anchor" })
    .filter((r) => r.status === "completed" && r.tx_hash);

  const seen = new Set<string>();
  const matched: AnchorWitness[] = [];
  const unwitnessed: AttestationReport["unwitnessed"] = [];
  for (const row of local) {
    const key = row.tx_hash!.toLowerCase();
    const hit = onChain.get(key);
    if (hit) {
      matched.push(hit);
      seen.add(key);
    } else {
      unwitnessed.push({
        tx_hash: row.tx_hash,
        execution_id: row.execution_id,
        charge_id: row.charge_id,
        created_at: new Date(row.created_at * 1000).toISOString(),
      });
    }
  }

  return {
    ...base,
    from_block: result.fromBlock,
    to_block: result.toBlock,
    matched,
    unwitnessed,
    unrecorded: [...onChain.entries()].filter(([k]) => !seen.has(k)).map(([, v]) => v),
  };
}
