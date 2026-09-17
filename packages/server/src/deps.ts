// Server dependency wiring. ONE process serves MCP + dashboard API + (P3) facilitator
// + seller + webhooks, routed by hostname. Engine objects are singletons here;
// tests build their own AppDeps with fakes.

import { privateKeyToAccount } from "viem/accounts";
import { isAddress } from "viem";
import type { Hex } from "viem";
import {
  CHAIN_ID,
  KeyedMutex,
  Relayer,
  Store,
  keeperhub,
  type DelegationSigner,
  type Executor,
  type FinalizeOpsDeps,
  type SpendDeps,
} from "@attestpay/engine";
import { makePrivyVerifier, type PrivyVerifier } from "./api/privy";
import { makeStripeClient, type StripeClient } from "./stripe/client";
import { makeFiatSettler, type FiatSettler } from "./stripe/settlement";
import { veniceChat, type ChatFn } from "./venice/client";
import { EventBus } from "./events/bus";
import { EventStore } from "./events/store";
import { TeamStore } from "./teams/store";
import { installNotificationRelay } from "./keeperhub/notify";

/** The KeeperHub execution layer: what moves the money under the card's authorization. */
export type KeeperHubDeps = {
  mode: keeperhub.ExecutorMode;
  config: keeperhub.KeeperHubConfig | null;
  client: keeperhub.KeeperHubClient | null;
  /** plans + execution audit records; always present so the dashboard can render */
  store: keeperhub.KeeperHubStore;
  /** writes PaymentAnchor receipts through KeeperHub (null = no anchor configured) */
  anchorer: keeperhub.KeeperHubAnchorer | null;
  /** on-chain receipts for confirmed payments (null = no anchor configured) */
  receipts: keeperhub.ReceiptService | null;
  disabledReason: string | null;
};

export type AppDeps = {
  store: Store;
  /** the execution layer (KeeperHubExecutor by default; legacy Relayer on ATTESTPAY_EXECUTOR=1shot) */
  relayer: Executor;
  /** dev-mode server-side signer for A_user (local key); P4 adds the pre-signed Privy path */
  userSigner: DelegationSigner | null;
  /** ops bearer token (server-side curl/scripts lane; full access) */
  adminToken: string | null;
  /** Privy session verifier (per-user dashboard lane); null = lane disabled */
  verifyPrivyToken: PrivyVerifier | null;
  /** serializes spends per card tree (root id) so concurrent spends can't double-approve a budget */
  spendMutex: KeyedMutex;
  spendOverrides?: Partial<SpendDeps>;
  /** test seams for the client-signed admin ops (codeCheck/confirmViaChain/nonce) */
  opsOverrides?: Partial<FinalizeOpsDeps>;
  /** Venice NL->CardTerms compiler brain; null/absent = /cards/compile disabled (no VENICE_API_KEY) */
  veniceChat?: ChatFn | null;
  /** Basescan API key for verified-contract labels in compiled drafts (optional) */
  basescanKey?: string | null;
  /** Stripe Issuing REST client (test-mode-only); null = fiat trigger/credential tools disabled */
  stripe?: StripeClient | null;
  /** drives approved fiat charge rows through spend(); null = settlement mode off */
  fiatSettler?: FiatSettler | null;
  /** Events, webhooks, audit log and budget alerts. Absent in fakes that don't need
   * them; every consumer treats it as optional. */
  events?: EventBus;
  /** Teams and roles over cards. Optional like the rest; absent means owner-only access. */
  teams?: TeamStore;
  /** KeeperHub execution layer. Optional in fakes; realDeps always sets it. */
  keeperhub?: KeeperHubDeps;
};

/** Numeric env with a default that survives the empty string. `Number(x ?? d)` is a trap:
 * `.env.example` ships optional vars as `KEY=` and Bun loads them as "", which `??`
 * passes through and Number("") coerces to 0 — silently zeroing rate limits and
 * intervals. Empty/missing/non-numeric all fall back to the default. */
export function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) ? n : def;
}

/** Builds the execution layer from env. KeeperHub unless ATTESTPAY_EXECUTOR=1shot; a
 * KeeperHub selection without a key yields an executor that fails every payment loudly. */
export function executionLayer(store: Store): { relayer: Executor; keeperhub: KeeperHubDeps } {
  const khStore = new keeperhub.KeeperHubStore(store.db);
  const mode = keeperhub.executorMode();
  if (mode === "1shot") {
    console.warn(
      "[executor] LEGACY 1Shot relayer selected (ATTESTPAY_EXECUTOR=1shot). KeeperHub dry runs, workflows and audit trail are OFF.",
    );
    return {
      relayer: new Relayer(),
      keeperhub: { mode, config: null, client: null, store: khStore, anchorer: null, receipts: null, disabledReason: "ATTESTPAY_EXECUTOR=1shot" },
    };
  }
  const config = keeperhub.keeperhubConfig();
  if (!config) {
    const reason = keeperhub.keeperhubDisabledReason() ?? "not configured";
    console.error(
      `[keeperhub] NOT CONFIGURED (${reason}): every payment will fail with keeperhub_not_configured. Set KEEPERHUB_API_KEY, or ATTESTPAY_EXECUTOR=1shot to roll back.`,
    );
    return {
      relayer: new keeperhub.UnconfiguredKeeperHubExecutor(reason),
      keeperhub: { mode, config: null, client: null, store: khStore, anchorer: null, receipts: null, disabledReason: reason },
    };
  }
  const client = new keeperhub.KeeperHubClient(config);
  // Accept the key with or without the 0x prefix. Operators copy keys between vars,
  // and a bare-hex key would otherwise fail deep inside viem with "invalid private key", far from the cause.
  const rawSponsorPk = process.env.ATTESTPAY_7702_SPONSOR_PK?.trim();
  const sponsorPk = rawSponsorPk ? ((rawSponsorPk.startsWith("0x") ? rawSponsorPk : `0x${rawSponsorPk}`) as Hex) : undefined;
  const executor = new keeperhub.KeeperHubExecutor({
    config,
    client,
    store: khStore,
    bootstrap7702: sponsorPk
      ? keeperhub.makeSponsor7702Bootstrap(sponsorPk, {
          onSubmitted: (hash, account) => console.log(`[keeperhub] 7702 upgrade ${hash} submitted for ${account}`),
        })
      : null,
  });
  const wf = Object.entries(config.workflows)
    .map(([k, v]) => `${k}=${v ?? "-"}`)
    .join(" ");
  console.log(
    `[keeperhub] execution layer ENABLED · api=${config.apiBase} · dry-run gate=${config.dryRunRequired ? "on" : "OFF"} · workflows ${wf}`,
  );
  return {
    relayer: executor,
    keeperhub: { mode, config, client, store: khStore, anchorer: null, receipts: null, disabledReason: null },
  };
}

export function realDeps(): AppDeps {
  const store = new Store(); // ATTESTPAY_DB_PATH or :memory:
  const { relayer, keeperhub: khDeps } = executionLayer(store);
  const pk = process.env.ATTESTPAY_DEV_USER_PK as Hex | undefined;
  // .trim(): a pasted-into-a-dashboard env var is the single most common way this
  // silently breaks — a trailing newline/space survives copy-paste and makes every
  // token fail the `aud` check below with an opaque 401 "unauthorized".
  const privyAppId = process.env.ATTESTPAY_PRIVY_APP_ID?.trim() || undefined;
  const deps: AppDeps = {
    store,
    relayer,
    userSigner: pk ? privateKeyToAccount(pk) : null,
    adminToken: process.env.ATTESTPAY_ADMIN_TOKEN ?? null,
    verifyPrivyToken: privyAppId ? makePrivyVerifier(privyAppId) : null,
    spendMutex: new KeyedMutex(),
    veniceChat: process.env.VENICE_API_KEY ? veniceChat() : null,
    basescanKey: process.env.BASESCAN_API_KEY ?? null,
    stripe: makeStripeClient(),
    events: new EventBus(new EventStore(store.db), store),
    teams: new TeamStore(store.db),
    keeperhub: khDeps,
  };

  // On-chain receipts: every confirmed payment gets a PaymentAnchor record, written by
  // KeeperHub on the settlement chain. Optional — without an anchor address payments
  // work exactly the same and simply carry no receipt.
  if (khDeps.config && khDeps.client && khDeps.config.receiptAnchorAddress) {
    khDeps.anchorer = new keeperhub.KeeperHubAnchorer({
      client: khDeps.client,
      config: khDeps.config,
      store: khDeps.store,
      anchorAddress: khDeps.config.receiptAnchorAddress,
      anchorChainId: CHAIN_ID,
    });
    khDeps.receipts = new keeperhub.ReceiptService({
      store,
      executions: khDeps.store,
      anchorer: khDeps.anchorer,
      paymentChainId: CHAIN_ID,
      anchorChainId: CHAIN_ID,
      log: (line) => console.log(line),
    });
    console.log(`[receipts] on-chain receipts ENABLED · PaymentAnchor ${khDeps.config.receiptAnchorAddress} on chain ${CHAIN_ID}`);
  } else if (khDeps.config) {
    console.log("[receipts] disabled · KEEPERHUB_RECEIPT_ANCHOR_ADDRESS is not set");
  }
  // the settler closes over the full deps object (store + mutex + spend seams).
  // A malformed settlement address would book every approved charge against a
  // recipient the relayer can never pay (parking rows + freezing cards), so a bad
  // value disables on-chain settlement LOUDLY and the lane falls back to ledger-only.
  const settleAddr = process.env.ATTESTPAY_SETTLEMENT_ADDRESS;
  let settlementOk = process.env.ATTESTPAY_FIAT_SETTLEMENT === "1";
  if (settlementOk && settleAddr && !isAddress(settleAddr)) {
    console.error("[deps] ATTESTPAY_SETTLEMENT_ADDRESS is not a valid address; on-chain settlement DISABLED (fiat lane falls back to ledger-only)");
    settlementOk = false;
  }
  deps.fiatSettler = settlementOk ? makeFiatSettler(deps) : null;
  installNotificationRelay(deps);
  return deps;
}

/** The card-tree key a spend serializes on: the root ancestor (whole subtree shares budget). */
export function spendKey(store: Store, cardId: string): string {
  const chain = store.ancestorChain(cardId);
  return chain.length ? chain[chain.length - 1]!.id : cardId;
}

export function spendDeps(deps: AppDeps): SpendDeps {
  return {
    store: deps.store,
    relayer: deps.relayer,
    plans: deps.keeperhub?.store ?? null,
    planTtlSeconds: deps.keeperhub?.config?.planTtlSeconds,
    // Every confirmed charge is announced and queued for its on-chain receipt. Both are
    // fire-and-forget, so `pay` still returns as soon as the payment confirms.
    onChargeConfirmed: onChargeConfirmed(deps),
    ...deps.spendOverrides,
  };
}

/** The confirmed-charge hook: announces the payment and queues its on-chain receipt. */
export function onChargeConfirmed(deps: AppDeps): (chargeId: string, cardId: string) => void {
  return (chargeId, cardId) => {
    if (deps.events) {
      const ch = deps.store.getCharge(chargeId);
      deps.events.emit("charge.confirmed", { cardId }, {
        charge_id: chargeId,
        card_id: cardId,
        kind: ch?.kind ?? null,
        to: ch?.to_addr ?? null,
        amount: ch ? (Number(ch.amount_atoms) / 1e6).toFixed(6) : null,
        fee: ch ? (Number(ch.fee_atoms) / 1e6).toFixed(6) : null,
        tx_hash: ch?.tx_hash ?? null,
        memo: ch?.memo ?? null,
      });
      deps.events.checkBudget(cardId);
    }
    deps.keeperhub?.receipts?.enqueue(chargeId);
  };
}
