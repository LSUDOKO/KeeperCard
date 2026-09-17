// Local record of everything KeeperCard asked KeeperHub to do.
//
//   keeperhub_plans       reviewed dry runs: the exact signed redemption an agent saw,
//                         executable once, until it expires
//   keeperhub_executions  every dry run / execution / anchor / notification KeeperHub
//                         ran for us, keyed by KeeperHub's executionId, so the audit
//                         trail survives even when KeeperHub's own history pages past it
//
// Lives on the same SQLite handle as the core Store.

import type { Database } from "bun:sqlite";
import type { Address, Hex } from "viem";
import type { RelayerTransaction } from "../relayer";
import type { ChargeKind } from "../store";
import type { Wire7702Auth } from "../types";

export type KeeperHubAction =
  | "dry_run"
  | "execute"
  | "anchor"
  | "notify"
  | "reconcile"
  | "settle_sweep"
  | "bootstrap";

export type KeeperHubSurface = "direct" | "workflow";

export type KeeperHubExecutionStatus =
  | "simulated"
  | "simulation_failed"
  | "pending"
  | "running"
  | "unconfirmed"
  | "completed"
  | "failed";

export type KeeperHubExecutionRow = {
  id: string;
  execution_id: string | null;
  surface: KeeperHubSurface;
  workflow_key: string | null;
  workflow_id: string | null;
  action: KeeperHubAction;
  card_id: string | null;
  charge_id: string | null;
  digest: Hex | null;
  status: KeeperHubExecutionStatus;
  tx_hash: Hex | null;
  chain_id: number | null;
  error: string | null;
  detail: Record<string, unknown>;
  created_at: number;
  updated_at: number;
};

export type PlanStatus = "open" | "executed" | "expired" | "failed";

export type SpendPlanRow = {
  id: string;
  card_id: string;
  digest: Hex;
  kind: ChargeKind;
  mode: "pay" | "contract";
  to_addr: Address | null;
  amount_atoms: bigint;
  fee_atoms: bigint;
  memo: string | null;
  idempotency_key: string | null;
  transactions: RelayerTransaction[];
  authorization_list: Wire7702Auth[] | null;
  context: string;
  simulation: Record<string, unknown>;
  status: PlanStatus;
  charge_id: string | null;
  created_at: number;
  expires_at: number;
};

type PlanDbRow = Omit<SpendPlanRow, "amount_atoms" | "fee_atoms" | "transactions" | "authorization_list" | "simulation"> & {
  amount_atoms: string;
  fee_atoms: string;
  transactions_json: string;
  authorization_json: string | null;
  simulation_json: string;
};

type ExecutionDbRow = Omit<KeeperHubExecutionRow, "detail"> & { detail_json: string };

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export class KeeperHubStore {
  constructor(readonly db: Database) {
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS keeperhub_executions (
        id TEXT PRIMARY KEY,
        execution_id TEXT,
        surface TEXT NOT NULL,
        workflow_key TEXT,
        workflow_id TEXT,
        action TEXT NOT NULL,
        card_id TEXT,
        charge_id TEXT,
        digest TEXT,
        status TEXT NOT NULL,
        tx_hash TEXT,
        chain_id INTEGER,
        error TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kh_exec_execution
        ON keeperhub_executions(execution_id) WHERE execution_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_kh_exec_card ON keeperhub_executions(card_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_kh_exec_charge ON keeperhub_executions(charge_id);
      CREATE INDEX IF NOT EXISTS idx_kh_exec_digest ON keeperhub_executions(digest);
      CREATE INDEX IF NOT EXISTS idx_kh_exec_created ON keeperhub_executions(created_at);

      CREATE TABLE IF NOT EXISTS keeperhub_plans (
        id TEXT PRIMARY KEY,
        card_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        kind TEXT NOT NULL,
        mode TEXT NOT NULL,
        to_addr TEXT,
        amount_atoms TEXT NOT NULL,
        fee_atoms TEXT NOT NULL,
        memo TEXT,
        idempotency_key TEXT,
        transactions_json TEXT NOT NULL,
        authorization_json TEXT,
        context TEXT NOT NULL,
        simulation_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        charge_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kh_plans_card ON keeperhub_plans(card_id, created_at);
    `);
  }

  // ---- executions ----

  record(
    row: Omit<KeeperHubExecutionRow, "id" | "created_at" | "updated_at" | "detail"> & {
      detail?: Record<string, unknown>;
      now?: number;
    },
  ): KeeperHubExecutionRow {
    const now = row.now ?? Math.floor(Date.now() / 1000);
    // an idempotent replay hands back an executionId we already hold: update, don't duplicate
    if (row.execution_id) {
      const existing = this.byExecutionId(row.execution_id);
      if (existing) {
        this.update(existing.id, {
          status: row.status,
          tx_hash: row.tx_hash ?? undefined,
          error: row.error ?? undefined,
          charge_id: row.charge_id ?? undefined,
          card_id: row.card_id ?? undefined,
          detail: row.detail,
          now,
        });
        return this.get(existing.id)!;
      }
    }
    const id = crypto.randomUUID();
    this.db
      .query(
        `INSERT INTO keeperhub_executions
          (id, execution_id, surface, workflow_key, workflow_id, action, card_id, charge_id, digest,
           status, tx_hash, chain_id, error, detail_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        row.execution_id,
        row.surface,
        row.workflow_key,
        row.workflow_id,
        row.action,
        row.card_id,
        row.charge_id,
        row.digest,
        row.status,
        row.tx_hash,
        row.chain_id,
        row.error,
        JSON.stringify(row.detail ?? {}),
        now,
        now,
      );
    return this.get(id)!;
  }

  update(
    id: string,
    fields: {
      status?: KeeperHubExecutionStatus;
      tx_hash?: Hex;
      error?: string;
      charge_id?: string;
      card_id?: string;
      detail?: Record<string, unknown>;
      now?: number;
    },
  ): void {
    const row = this.get(id);
    if (!row) return;
    const now = fields.now ?? Math.floor(Date.now() / 1000);
    const detail = fields.detail ? { ...row.detail, ...fields.detail } : row.detail;
    this.db
      .query(
        `UPDATE keeperhub_executions SET
           status = ?, tx_hash = ?, error = ?, charge_id = ?, card_id = ?, detail_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        fields.status ?? row.status,
        fields.tx_hash ?? row.tx_hash,
        fields.error ?? row.error,
        fields.charge_id ?? row.charge_id,
        fields.card_id ?? row.card_id,
        JSON.stringify(detail),
        now,
        id,
      );
  }

  /** Attach charge/card ids to every record for a plan digest (dry run + execution). */
  linkDigest(digest: Hex, ids: { charge_id?: string; card_id?: string }): void {
    if (ids.charge_id) {
      this.db.query(`UPDATE keeperhub_executions SET charge_id = ? WHERE digest = ? AND charge_id IS NULL`).run(ids.charge_id, digest);
    }
    if (ids.card_id) {
      this.db.query(`UPDATE keeperhub_executions SET card_id = ? WHERE digest = ? AND card_id IS NULL`).run(ids.card_id, digest);
    }
  }

  get(id: string): KeeperHubExecutionRow | null {
    const r = this.db.query(`SELECT * FROM keeperhub_executions WHERE id = ?`).get(id) as ExecutionDbRow | null;
    return r ? this.fromDb(r) : null;
  }

  byExecutionId(executionId: string): KeeperHubExecutionRow | null {
    const r = this.db
      .query(`SELECT * FROM keeperhub_executions WHERE execution_id = ?`)
      .get(executionId) as ExecutionDbRow | null;
    return r ? this.fromDb(r) : null;
  }

  latestSimulation(digest: Hex): KeeperHubExecutionRow | null {
    const r = this.db
      .query(
        `SELECT * FROM keeperhub_executions WHERE digest = ? AND action = 'dry_run' ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(digest) as ExecutionDbRow | null;
    return r ? this.fromDb(r) : null;
  }

  forCharge(chargeId: string): KeeperHubExecutionRow[] {
    return (
      this.db
        .query(`SELECT * FROM keeperhub_executions WHERE charge_id = ? ORDER BY created_at ASC, rowid ASC`)
        .all(chargeId) as ExecutionDbRow[]
    ).map((r) => this.fromDb(r));
  }

  /** Audit trail for a set of cards (a card and its subtree), newest first. */
  forCards(cardIds: string[], limit = 50): KeeperHubExecutionRow[] {
    if (!cardIds.length) return [];
    const placeholders = cardIds.map(() => "?").join(",");
    return (
      this.db
        .query(
          `SELECT * FROM keeperhub_executions WHERE card_id IN (${placeholders})
           ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(...cardIds, limit) as ExecutionDbRow[]
    ).map((r) => this.fromDb(r));
  }

  recent(limit = 50, filter: { action?: KeeperHubAction; workflowKey?: string } = {}): KeeperHubExecutionRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.action) {
      where.push("action = ?");
      args.push(filter.action);
    }
    if (filter.workflowKey) {
      where.push("workflow_key = ?");
      args.push(filter.workflowKey);
    }
    const sql = `SELECT * FROM keeperhub_executions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    return (this.db.query(sql).all(...args, limit) as ExecutionDbRow[]).map((r) => this.fromDb(r));
  }

  /** Executions KeeperHub has not reported terminal yet: the recovery sweep's work list. */
  unresolved(olderThan: number, limit = 100): KeeperHubExecutionRow[] {
    return (
      this.db
        .query(
          `SELECT * FROM keeperhub_executions
           WHERE execution_id IS NOT NULL AND status IN ('pending','running','unconfirmed') AND updated_at <= ?
           ORDER BY updated_at ASC LIMIT ?`,
        )
        .all(olderThan, limit) as ExecutionDbRow[]
    ).map((r) => this.fromDb(r));
  }

  stats(since: number): {
    total: number;
    by_status: Record<string, number>;
    by_action: Record<string, number>;
    dry_runs: number;
    executions: number;
  } {
    const rows = this.db
      .query(`SELECT status, action, COUNT(*) AS n FROM keeperhub_executions WHERE created_at >= ? GROUP BY status, action`)
      .all(since) as Array<{ status: string; action: string; n: number }>;
    const by_status: Record<string, number> = {};
    const by_action: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      by_status[r.status] = (by_status[r.status] ?? 0) + r.n;
      by_action[r.action] = (by_action[r.action] ?? 0) + r.n;
      total += r.n;
    }
    return { total, by_status, by_action, dry_runs: by_action.dry_run ?? 0, executions: total - (by_action.dry_run ?? 0) };
  }

  private fromDb(r: ExecutionDbRow): KeeperHubExecutionRow {
    const { detail_json, ...rest } = r;
    return { ...rest, detail: parseJson(detail_json, {}) };
  }

  // ---- plans ----

  insertPlan(p: Omit<SpendPlanRow, "status" | "charge_id">): SpendPlanRow {
    this.db
      .query(
        `INSERT INTO keeperhub_plans
          (id, card_id, digest, kind, mode, to_addr, amount_atoms, fee_atoms, memo, idempotency_key,
           transactions_json, authorization_json, context, simulation_json, status, charge_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
      )
      .run(
        p.id,
        p.card_id,
        p.digest,
        p.kind,
        p.mode,
        p.to_addr,
        p.amount_atoms.toString(),
        p.fee_atoms.toString(),
        p.memo,
        p.idempotency_key,
        JSON.stringify(p.transactions),
        p.authorization_list ? JSON.stringify(p.authorization_list) : null,
        p.context,
        JSON.stringify(p.simulation),
        p.created_at,
        p.expires_at,
      );
    return this.getPlan(p.id)!;
  }

  getPlan(id: string): SpendPlanRow | null {
    const r = this.db.query(`SELECT * FROM keeperhub_plans WHERE id = ?`).get(id) as PlanDbRow | null;
    if (!r) return null;
    const { transactions_json, authorization_json, simulation_json, amount_atoms, fee_atoms, ...rest } = r;
    return {
      ...rest,
      amount_atoms: BigInt(amount_atoms),
      fee_atoms: BigInt(fee_atoms),
      transactions: parseJson(transactions_json, []),
      authorization_list: parseJson<Wire7702Auth[] | null>(authorization_json, null),
      simulation: parseJson(simulation_json, {}),
    };
  }

  plansForCard(cardId: string, limit = 20): SpendPlanRow[] {
    const ids = this.db
      .query(`SELECT id FROM keeperhub_plans WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(cardId, limit) as Array<{ id: string }>;
    return ids.map((r) => this.getPlan(r.id)!).filter(Boolean);
  }

  /** Atomically claim an open, unexpired plan for execution. False = someone else has it. */
  claimPlan(id: string, now: number): boolean {
    const res = this.db
      .query(`UPDATE keeperhub_plans SET status = 'executed' WHERE id = ? AND status = 'open' AND expires_at > ?`)
      .run(id, now);
    return res.changes === 1;
  }

  setPlanStatus(id: string, status: PlanStatus, chargeId?: string): void {
    this.db
      .query(`UPDATE keeperhub_plans SET status = ?, charge_id = COALESCE(?, charge_id) WHERE id = ?`)
      .run(status, chargeId ?? null, id);
  }
}
