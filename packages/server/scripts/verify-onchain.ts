// Independent check of the transactions KeeperHub executed for KeeperCard. Nothing here
// talks to KeeperHub or to KeeperCard: every line is read from a public Base Sepolia RPC.
//   bun run --cwd packages/server verify:onchain

import { createPublicClient, formatUnits, http, type Address, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

const RPC = "https://sepolia.base.org";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address;
const ANCHOR = "0x56733223c688cce7fc65826b692b3f8521e4ab3e" as Address;

const TXS: Array<{ label: string; hash: Hex; expect: "payment" | "receipt" }> = [
  // production (attestpay-api.onrender.com), paid by an agent over MCP
  { label: "production payment 0.02 USDC", hash: "0xcdc5ef7216fe80fea61f82d55da7f53208c2c98206ad0213f0269a2c17b75ed6", expect: "payment" },
  { label: "  receipt for the above", hash: "0x93a3f70123e172a9e9f3f97ca8a1ac80654edfb961cf1e8a6bb133a6457615da", expect: "receipt" },
  { label: "production payment 0.05 USDC", hash: "0x28804b5315f8ec86446bfdd62f7a30d76c157b13e33cb9ffedad8c0a10ca40f7", expect: "payment" },
  { label: "  receipt for the above", hash: "0x95c4f1f940d227a307e6e853ce6f830e5c1b50e8a1fc9bbc9349c38cd6451d3d", expect: "receipt" },
  // local server against live KeeperHub
  { label: "card payment 0.01 USDC", hash: "0x54b1651ca19d7c557c028ef9d22949b609df4cff3dbdb3c4f3857e26f547b406", expect: "payment" },
  { label: "card payment 0.02 USDC", hash: "0x3c20c3d19a49a806bb95ecc9d3874cd73084368c3c22c54616d24205fe4d986b", expect: "payment" },
  { label: "  receipt for the above", hash: "0xaee6c91062c90a332881ebf35780c2470a72e85ffd8bda78239d3465bd55531e", expect: "receipt" },
  { label: "guarded payment 0.06 USDC", hash: "0xc9368f9e49af1fc387f9ff2483cbb733ca5a53caacbc65fdd9a9913802fe0869", expect: "payment" },
  { label: "  receipt for the above", hash: "0x9ac752e24178a9604c122c4d61dec1cc48027bb7e5c3a9f66f41a70f50b24219", expect: "receipt" },
];

const client = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
let failures = 0;

console.log(`source: ${RPC} (chain ${baseSepolia.id})\n`);
for (const tx of TXS) {
  const r = await client.getTransactionReceipt({ hash: tx.hash });
  const usdcLogs = r.logs.filter((l) => same(l.address, USDC));
  const anchorLogs = r.logs.filter((l) => same(l.address, ANCHOR));
  // the emitter is what is checked: on a sponsored route receipt.to is a wrapper
  const effect = tx.expect === "payment" ? usdcLogs.length >= 2 : anchorLogs.length === 1;
  const ok = r.status === "success" && effect;
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${tx.label}`);
  console.log(`    ${tx.hash}`);
  console.log(`    block ${r.blockNumber} · status ${r.status} · gas ${r.gasUsed}`);
  if (tx.expect === "payment") {
    for (const l of usdcLogs) {
      const to = `0x${l.topics[2]!.slice(26)}`;
      console.log(`    USDC Transfer → ${to.slice(0, 8)}…${to.slice(-4)}  ${formatUnits(BigInt(l.data), 6)} USDC`);
    }
  } else {
    console.log(`    PaymentAnchored emitted by PaymentAnchor ${ANCHOR.slice(0, 10)}… (${anchorLogs.length} log)`);
  }
}
console.log(failures ? `\n${failures} transaction(s) did not verify` : `\nall ${TXS.length} transactions verified on-chain`);
process.exit(failures ? 1 : 0);
