// DelegationManager.redeemDelegations calldata for KeeperHub.
//
// The 1Shot relayer encoded redemptions server-side; with KeeperHub, KeeperCard encodes
// them itself so the bytes that are dry-run, reviewed and executed are provably the
// same bytes. The digest (keccak256 of the calldata) is the identity of a plan.

import { encodeDelegations, encodeExecutionCalldatas } from "@metamask/smart-accounts-kit/utils";
import { encodeFunctionData, keccak256, type Address, type Hex } from "viem";
import type { RelayerTransaction } from "../relayer";

export const REDEEM_DELEGATIONS_ABI = [
  {
    type: "function",
    name: "redeemDelegations",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_permissionContexts", type: "bytes[]" },
      { name: "_modes", type: "bytes32[]" },
      { name: "_executionCallDatas", type: "bytes[]" },
    ],
    outputs: [],
  },
] as const;

/** ERC-7579 call types: one execution is a single call, several are a batch. */
export const EXECUTION_MODE_SINGLE: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
export const EXECUTION_MODE_BATCH: Hex = "0x0100000000000000000000000000000000000000000000000000000000000000";

export type EncodedRedemption = {
  /** full calldata for DelegationManager */
  data: Hex;
  /** keccak256(data): the plan identity carried from dry run to execution */
  digest: Hex;
  /** the three ABI arguments, for a KeeperHub write-contract node's functionArgs */
  args: [Hex[], Hex[], Hex[]];
  /** JSON string form of args, exactly what the workflow node receives */
  functionArgs: string;
  executionCount: number;
};

function executionCalldata(executions: RelayerTransaction["executions"]): { mode: Hex; data: Hex } {
  if (executions.length === 0) throw new Error("redemption item has no executions");
  // the kit's canonical ERC-7579 encoder: packed single call for one execution,
  // abi-encoded (target,value,callData)[] for a batch; the mode must agree with it
  const [data] = encodeExecutionCalldatas([
    executions.map((e) => ({ target: e.target as Address, value: BigInt(e.value), callData: e.data })),
  ]);
  return { mode: executions.length === 1 ? EXECUTION_MODE_SINGLE : EXECUTION_MODE_BATCH, data: data as Hex };
}

export function encodeRedemption(transactions: RelayerTransaction[]): EncodedRedemption {
  if (!transactions.length) throw new Error("redemption has no transactions");
  const permissionContexts: Hex[] = [];
  const modes: Hex[] = [];
  const executionCallDatas: Hex[] = [];
  let executionCount = 0;
  for (const t of transactions) {
    // One redemption ENTRY per execution, always in single call-type mode.
    //
    // Every caveat enforcer on a card's leaf and root chain (ERC20TransferAmount,
    // ERC20PeriodTransfer, AllowedTargets, AllowedMethods, ValueLte, …) declares
    // `onlySingleCallTypeMode`, so the DelegationManager reverts a batch-mode entry with
    // CaveatEnforcer:invalid-call-type before any transfer happens. A pay carries two
    // executions — the merchant transfer and the gas-fee leg — so encoding it as one
    // batch entry made every card payment fail on-chain.
    //
    // redeemDelegations takes three parallel arrays, so the same permission context is
    // simply repeated per execution. All entries still settle in ONE transaction, which
    // is what keeps a payment and its fee atomic.
    const context = encodeDelegations(t.permissionContext as never) as Hex;
    for (const execution of t.executions) {
      const { mode, data } = executionCalldata([execution]);
      permissionContexts.push(context);
      modes.push(mode);
      executionCallDatas.push(data);
      executionCount += 1;
    }
  }
  const args: [Hex[], Hex[], Hex[]] = [permissionContexts, modes, executionCallDatas];
  const data = encodeFunctionData({ abi: REDEEM_DELEGATIONS_ABI, functionName: "redeemDelegations", args });
  return { data, digest: keccak256(data), args, functionArgs: JSON.stringify(args), executionCount };
}
