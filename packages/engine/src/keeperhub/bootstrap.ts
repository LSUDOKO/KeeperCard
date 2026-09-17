// One-time EIP-7702 upgrade for accounts that have never spent.
//
// The 1Shot relayer accepted an authorizationList and upgraded the user's EOA in the
// same transaction as the first redemption. KeeperHub's write paths submit ordinary
// (type-2) transactions, so the upgrade is split out: AttestPay submits the user's own
// signed authorization in a zero-value type-4 transaction from a small sponsor key,
// waits for the code to land, and the redemption itself then goes through KeeperHub
// like every other payment. No value moves in the bootstrap transaction.
//
// Idempotent: an account that already has code returns immediately, so the spend
// loop's estimate retries can call it freely.

import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAINS, publicClient, rpcUrl, type ChainId } from "../chains";
import { has7702Code } from "../delegations";
import { EngineError } from "../errors";
import type { Wire7702Auth } from "../types";
import type { Bootstrap7702 } from "./executor";

export function makeSponsor7702Bootstrap(
  sponsorPk: Hex,
  opts: {
    codeCheck?: (address: Address, chainId: ChainId) => Promise<boolean>;
    onSubmitted?: (txHash: Hex, account: Address) => void;
    /** test seam for the post-upgrade code-propagation retries */
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Bootstrap7702 {
  const account = privateKeyToAccount(sponsorPk);
  const codeCheck = opts.codeCheck ?? has7702Code;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (authorizationList: Wire7702Auth[], chainId: ChainId): Promise<Hex> => {
    const auth = authorizationList[0];
    if (!auth) throw new EngineError("bootstrap", "empty authorization list");
    // the authority is the EOA that signed the authorization; recover it from the
    // signature rather than trusting a caller-supplied address
    const { recoverAuthorizationAddress } = await import("viem/utils");
    const signed = {
      address: auth.address,
      chainId: Number(BigInt(auth.chainId)),
      nonce: Number(BigInt(auth.nonce)),
      r: auth.r,
      s: auth.s,
      yParity: Number(BigInt(auth.yParity)),
    };
    const authority = await recoverAuthorizationAddress({ authorization: signed });
    if (await codeCheck(authority, chainId)) return "0x" as Hex;

    const wallet = createWalletClient({ account, chain: CHAINS[chainId].chain, transport: http(rpcUrl(chainId)) });
    let hash: Hex;
    try {
      hash = await wallet.sendTransaction({
        to: authority,
        value: 0n,
        data: "0x",
        authorizationList: [signed],
      });
    } catch (e) {
      throw new EngineError("bootstrap", `7702 upgrade transaction rejected: ${e instanceof Error ? e.message : String(e)}`, e);
    }
    opts.onSubmitted?.(hash, authority);
    const receipt = await publicClient(chainId).waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") {
      throw new EngineError("bootstrap", `7702 upgrade ${hash} reverted on chain ${chainId}`);
    }
    // A mined receipt does not mean every RPC node serves the new code yet: eth_getCode
    // can still answer from a slightly stale view, and a load-balanced endpoint may route
    // the read to a different node than the one that accepted the transaction. Failing
    // here would reject a payment whose upgrade actually landed, so give the read a few
    // short retries before calling it a failure.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await codeCheck(authority, chainId)) return hash;
      await sleep(400 * (attempt + 1));
    }
    throw new EngineError(
      "bootstrap",
      `7702 upgrade ${hash} was mined successfully but ${authority} still reports no account code; the RPC may be lagging — retry the payment`,
    );
  };
}
