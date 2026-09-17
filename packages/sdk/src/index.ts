// @attestpay/sdk — a typed client for the KeeperCard API.
//
// One class, one `fetch`, no framework. One thing beyond the HTTP wrapper is
// included because every integrator needs it and getting it subtly wrong is easy:
// verifying a webhook signature. It is a pure function that works in Node, Bun,
// browsers and workers.
//
//   const kc = new KeeperCard({ baseUrl: "https://api.example.com", token: PRIVY_OR_ADMIN_TOKEN });
//   const cards = await kc.cards.list();
//   const plan = await kc.keeperhub.dryRun(cards[0].card_id, { to: MERCHANT, amount: "4.00" });
//
// The ops token acts for a user by passing `userId`; a Privy access token is already
// bound to its wallet and `userId` is ignored server-side.

import type { Address } from "viem";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A non-2xx answer. `code` is the typed refusal (over_period_limit, card_not_found,
 * ...) when the server sent one, so callers can branch without parsing messages. */
export class KeeperCardError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
    readonly detail: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = "KeeperCardError";
  }
}

// ---------------------------------------------------------------------------
// Shapes (the server's JSON, named)
// ---------------------------------------------------------------------------

export type CardTerms = {
  pay?: { period?: { amount: string; seconds: number }; lifetime?: { amount: string } };
  contract?: { targets: string[]; selectors: string[]; tokens?: string[]; perTradeMax?: string };
  expiry?: number;
  maxUses?: number;
  perTxMax?: string;
  merchants?: string[];
  subcards?: boolean;
};

export type CardState = {
  card_id: string;
  name: string;
  status: string;
  terms: CardTerms;
  remaining_this_period: string | null;
  remaining_lifetime: string | null;
  period_resets_at: number | null;
  expires_at: number | null;
  uses_remaining: number | null;
  subcards: string[];
  parent_card_id?: string | null;
  created_at?: number;
  team?: { team_id: string; name: string } | null;
  your_role?: TeamRole;
};

export type Charge = { id: string; kind: string; to: string | null; amount: string; fee: string; status: string; tx: string | null; memo: string | null; at: number };

export type CardDetail = CardState & { charges: Charge[]; k_agent_address: string };

export type Receipt = { status: "confirmed" | "pending" | "failed" | "settlement_unconfirmed"; tx: string | null; to: string; amount: string; fee: string; remaining_this_period: string | null; memo?: string };

export type Webhook = { webhook_id: string; url: string; events: string[]; description: string | null; active: boolean; created_at: string | null; updated_at: string | null };
export type Delivery = { delivery_id: string; event_id: string; event_type: string; status: "pending" | "delivered" | "failed" | "dead"; attempts: number; next_attempt_at: string | null; last_status_code: number | null; last_error: string | null; created_at: string | null; delivered_at: string | null };
export type EventRow = { id: string; type: string; user_id: string | null; card_id: string | null; data: Record<string, unknown>; created_at: string };
export type AuditEntry = { id: number; at: string; actor: string; action: string; target: string; detail: Record<string, unknown> | null; ip: string | null };

export type TeamRole = "owner" | "admin" | "member" | "viewer";
export type Team = {
  team_id: string;
  name: string;
  owner: string;
  your_role: TeamRole;
  members: Array<{ user_id: string; role: TeamRole; added_by: string; since: string }>;
  cards: Array<{ card_id: string; name: string | null; status: string | null; owner: string | null }>;
  created_at: string;
};

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export type KeeperCardOptions = {
  /** e.g. https://api.example.com (the server root, not /api) */
  baseUrl: string;
  /** A Privy access token or the ops token; a function is called per request (token refresh). */
  token: string | (() => Promise<string> | string);
  /** With the ops token: the user to act as. Ignored on a Privy token. */
  userId?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class KeeperCard {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: KeeperCardOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async token(): Promise<string> {
    return typeof this.opts.token === "function" ? await this.opts.token() : this.opts.token;
  }

  /** The request core: JSON in, JSON out, typed refusals as KeeperCardError. */
  async call<T>(method: string, path: string, body?: unknown, opts: { raw?: boolean; public?: boolean } = {}): Promise<T> {
    const url = new URL(`${this.base}${path}`);
    // Ops-token acting-as: userId rides the query for reads and deletes, the body otherwise.
    let payload = body;
    if (this.opts.userId) {
      if (method === "GET" || method === "DELETE") url.searchParams.set("userId", this.opts.userId);
      else payload = { userId: this.opts.userId, ...((body as Record<string, unknown>) ?? {}) };
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (!opts.public) headers.authorization = `Bearer ${await this.token()}`;
    if (payload !== undefined) headers["content-type"] = "application/json";
    const res = await this.f(url, {
      method,
      headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (opts.raw) {
      if (!res.ok) throw new KeeperCardError(res.status, await res.text());
      return (await res.text()) as unknown as T;
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) throw new KeeperCardError(res.status, "malformed response body");
    }
    if (!res.ok) {
      const j = (json ?? {}) as { code?: string; message?: string; error?: string; detail?: Record<string, unknown> };
      throw new KeeperCardError(res.status, j.message ?? j.error ?? `http ${res.status}`, j.code ?? null, j.detail ?? null);
    }
    return json as T;
  }

  private get = <T>(path: string) => this.call<T>("GET", path);
  private post = <T>(path: string, body: unknown = {}) => this.call<T>("POST", path, body);
  private put = <T>(path: string, body: unknown) => this.call<T>("PUT", path, body);
  private patch = <T>(path: string, body: unknown) => this.call<T>("PATCH", path, body);
  private del = <T>(path: string) => this.call<T>("DELETE", path);

  // ---- cards ----
  readonly cards = {
    list: () => this.get<CardState[]>("/api/cards"),
    get: (id: string) => this.get<CardDetail>(`/api/cards/${id}`),
    tree: () => this.get<{ tree: Array<{ card: CardState; children: unknown[] }> }>("/api/tree"),
    url: (id: string) => this.get<{ card_url: string }>(`/api/cards/${id}/url`),
    rotate: (id: string) => this.post<{ card_url: string }>(`/api/cards/${id}/rotate`),
    freeze: (id: string) => this.post<{ status: string }>(`/api/cards/${id}/freeze`),
    unfreeze: (id: string) => this.post<{ status: string }>(`/api/cards/${id}/unfreeze`),
    delete: (id: string) => this.del<{ deleted: boolean; removed: number }>(`/api/cards/${id}`),
    /** Ops lane only: server-signed issuance. */
    issue: (name: string, terms: CardTerms) => this.post<{ card_id: string; card_url: string; terms: CardTerms }>("/api/cards", { name, terms }),
    assignTeam: (id: string, teamId: string | null) => this.post<{ card_id: string; team: { team_id: string; name: string } | null }>(`/api/cards/${id}/team`, { team_id: teamId }),
  };

  // ---- KeeperHub execution layer ----
  readonly keeperhub = {
    status: () => this.get<Record<string, unknown>>("/api/keeperhub/status"),
    workflows: () => this.get<Record<string, unknown>>("/api/keeperhub/workflows"),
    executions: (limit?: number) => this.get<Record<string, unknown>>(`/api/keeperhub/executions${query({ limit })}`),
    execution: (executionId: string) => this.get<Record<string, unknown>>(`/api/keeperhub/executions/${executionId}`),
    forCard: (cardId: string) => this.get<Record<string, unknown>>(`/api/cards/${cardId}/keeperhub`),
    /** Simulates the payment and returns a plan; `execute` takes its `plan_id`. */
    dryRun: (cardId: string, input: { to: string; amount: string; memo?: string; idempotency_key?: string }) =>
      this.post<Record<string, unknown>>(`/api/cards/${cardId}/keeperhub/dry-run`, input),
    execute: (cardId: string, input: { plan_id: string }) => this.post<Record<string, unknown>>(`/api/cards/${cardId}/keeperhub/execute`, input),
    attestation: (blocks?: number) => this.get<Record<string, unknown>>(`/api/keeperhub/attestation${query({ blocks })}`),
    treasury: () => this.get<Record<string, unknown>>("/api/keeperhub/treasury"),
    receipts: (cardId: string) => this.get<Record<string, unknown>>(`/api/cards/${cardId}/receipts`),
  };

  // ---- webhooks, events, audit, alerts ----
  readonly webhooks = {
    create: (input: { url: string; events?: string[]; description?: string }) => this.post<Webhook & { secret: string }>("/api/webhooks", input),
    list: () => this.get<{ configured: boolean; items: Webhook[]; event_types: readonly string[] }>("/api/webhooks"),
    delete: (id: string) => this.del<{ deleted: boolean }>(`/api/webhooks/${id}`),
    pause: (id: string, active: boolean) => this.post<Webhook>(`/api/webhooks/${id}/pause`, { active }),
    test: (id: string) => this.post<{ delivery: Delivery; result: Record<string, number> }>(`/api/webhooks/${id}/test`),
    deliveries: (id: string) => this.get<{ items: Delivery[] }>(`/api/webhooks/${id}/deliveries`),
    retry: (id: string, deliveryId: string) => this.post<{ retried: boolean; delivery: Delivery }>(`/api/webhooks/${id}/deliveries/${deliveryId}/retry`),
    /** Verify an incoming delivery's signature header. */
    verify: verifyWebhookSignature,
  };

  readonly events = {
    list: (q: { limit?: number; card_id?: string } = {}) => this.get<{ configured: boolean; items: EventRow[] }>(`/api/events${query(q)}`),
  };

  readonly audit = {
    list: (q: { from?: number; to?: number; card_id?: string; action?: string; limit?: number; all?: boolean } = {}) =>
      this.get<{ configured: boolean; items: AuditEntry[] }>(`/api/audit${query({ ...q, all: q.all ? "1" : undefined })}`),
    csv: (q: { from?: number; to?: number; card_id?: string; action?: string; limit?: number; all?: boolean } = {}) =>
      this.call<string>("GET", `/api/audit${query({ ...q, all: q.all ? "1" : undefined, format: "csv" })}`, undefined, { raw: true }),
  };

  readonly alerts = {
    get: (cardId: string) => this.get<{ card_id: string; threshold_pct: number }>(`/api/cards/${cardId}/alerts`),
    set: (cardId: string, thresholdPct: number) => this.put<{ card_id: string; threshold_pct: number }>(`/api/cards/${cardId}/alerts`, { threshold_pct: thresholdPct }),
  };

  // ---- teams ----
  readonly teams = {
    create: (name: string) => this.post<Team>("/api/teams", { name }),
    list: () => this.get<{ configured: boolean; items: Team[] }>("/api/teams"),
    get: (id: string) => this.get<Team>(`/api/teams/${id}`),
    rename: (id: string, name: string) => this.patch<Team>(`/api/teams/${id}`, { name }),
    delete: (id: string) => this.del<{ deleted: boolean }>(`/api/teams/${id}`),
    addMember: (id: string, input: { address?: Address; user_id?: string; role?: TeamRole }) => this.post<Team>(`/api/teams/${id}/members`, input),
    removeMember: (id: string, userId: string) => this.del<{ removed: boolean }>(`/api/teams/${id}/members/${userId}`),
  };
}

function query(q: Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Webhook signatures (WebCrypto, so it runs anywhere)
// ---------------------------------------------------------------------------

/** Verifies the `x-keepercard-signature` header (`t=<unix>,v1=<hex>`) over the raw request
 * body. Deliveries also carry `x-keepercard-event` and `x-keepercard-delivery`. */
export async function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  opts: { now?: number; toleranceSeconds?: number } = {},
): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? 300)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}
