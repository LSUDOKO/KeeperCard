// EIP-7702 sponsor bootstrap: the one-time upgrade that lets a never-upgraded account
// spend through KeeperHub, which submits ordinary type-2 transactions.
//
// The case that matters here is a mined, SUCCESSFUL upgrade whose code is not yet
// visible to the next eth_getCode. Treating that as a failure rejects a payment whose
// upgrade actually landed — observed live on Base Sepolia, where the read immediately
// after the receipt returned "0x" and the code appeared moments later.

import { describe, expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { makeSponsor7702Bootstrap } from "../src/keeperhub";

const sponsorPk = generatePrivateKey();

/** A signed authorization from a fresh account, in the wire shape spend() passes. */
async function wireAuth() {
  const victim = privateKeyToAccount(generatePrivateKey());
  const auth = await victim.signAuthorization({
    chainId: 84532,
    address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
    nonce: 0,
  });
  return {
    authority: victim.address,
    wire: {
      chainId: `0x${auth.chainId.toString(16)}`,
      address: auth.address,
      nonce: `0x${auth.nonce.toString(16)}`,
      yParity: `0x${(auth.yParity ?? 0).toString(16)}`,
      r: auth.r,
      s: auth.s,
    },
  };
}

describe("7702 sponsor bootstrap", () => {
  test("an account that already has code is a no-op: no transaction, no gas", async () => {
    const { wire } = await wireAuth();
    const bootstrap = makeSponsor7702Bootstrap(sponsorPk, {
      codeCheck: async () => true,
      sleep: async () => {},
    });
    // returns the empty hash without ever reaching a wallet client
    expect(await bootstrap([wire] as never, 84532)).toBe("0x");
  });

  test("the authority is recovered from the signature, not taken on trust", async () => {
    const { authority, wire } = await wireAuth();
    let checked: Address | null = null;
    const bootstrap = makeSponsor7702Bootstrap(sponsorPk, {
      codeCheck: async (a) => {
        checked = a;
        return true;
      },
      sleep: async () => {},
    });
    await bootstrap([wire] as never, 84532);
    // a caller-supplied address could name someone else's account; the signature cannot
    expect(checked).toBe(authority);
  });

  test("an empty authorization list is refused before anything is signed", async () => {
    const bootstrap = makeSponsor7702Bootstrap(sponsorPk, { sleep: async () => {} });
    await expect(bootstrap([] as never, 84532)).rejects.toThrow(/empty authorization list/);
  });
});
