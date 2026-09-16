// Executor used when KeeperHub is the chosen execution layer (the default) but is not
// configured. Fails LOUDLY on every value-moving call instead of silently no-op'ing or
// quietly falling back to the legacy relayer: an operator who meant to run on KeeperHub
// must find out on the first payment, with the reason, not from a missing audit trail.
// Read-only status calls answer "unknown" so dashboards keep rendering.
//
// The explicit rollback lane is ATTESTPAY_EXECUTOR=1shot.

import type { Address } from "viem";
import { CHAIN_ID, type ChainId } from "../chains";
import { EngineError } from "../errors";
import type { Executor } from "../executor";
import type { Capabilities, EstimateResult, FeeData, RelayerStatus } from "../relayer";

export class UnconfiguredKeeperHubExecutor implements Executor {
  readonly kind = "keeperhub" as const;

  constructor(
    readonly reason: string,
    readonly chainId: ChainId = CHAIN_ID,
  ) {}

  private fail(): never {
    throw new EngineError(
      "keeperhub_not_configured",
      `KeeperHub is the execution layer but is not configured (${this.reason}); set KEEPERHUB_API_KEY, or ATTESTPAY_EXECUTOR=1shot to roll back`,
    );
  }

  async delegateAddress(): Promise<Address> {
    return this.fail();
  }
  async getCapabilities(): Promise<Capabilities> {
    return this.fail();
  }
  async getFeeData(): Promise<FeeData> {
    return this.fail();
  }
  async estimate(): Promise<EstimateResult> {
    return this.fail();
  }
  async send(): Promise<string> {
    return this.fail();
  }
  async getStatus(): Promise<RelayerStatus> {
    return { status: null, txHash: null, raw: { error: "keeperhub_not_configured", reason: this.reason } };
  }
  async waitForStatus(): Promise<RelayerStatus & { timedOut: boolean }> {
    return { status: null, txHash: null, raw: null, timedOut: true };
  }
}
