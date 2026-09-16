"use client";

// The execution pane: what KeeperHub actually did with this account's money.
//
// AttestPay decides what may be spent. KeeperHub moves it. This pane is the second
// half — and like the Attestcoin pane, it is built around not overclaiming:
//
//   1. A dry run is not a payment. `simulated` rows are rendered as a rehearsal that
//      touched no chain, never mixed into the same count as executions. The digest is
//      shown on both so a reader can see for themselves that the executed bytes are
//      the reviewed bytes, rather than being told so.
//   2. `unconfirmed` is not `failed`. KeeperHub uses it for "submitted, not yet
//      terminal". Colouring it red would teach the user to panic at a working retry.
//   3. Absent is not broken. A workflow that needs a plan tier this org does not have
//      reads as unavailable with the reason, not as an error.
//   4. Every hash is a link. A tx the user cannot open on an explorer is decoration.

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type KeeperHubExecution,
  type KeeperHubLog,
  type KeeperHubStatus,
  type KeeperHubStatus_,
  type KeeperHubWorkflow,
} from "@/lib/api";
import { shortHex } from "./ui";

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<KeeperHubStatus, string> = {
  simulated: "Dry run",
  pending: "Submitting",
  unconfirmed: "Awaiting confirmation",
  completed: "Executed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** What each state means for the money, in the user's terms. */
const STATUS_NOTE: Record<KeeperHubStatus, string> = {
  simulated: "Rehearsed against KeeperHub's simulator — no chain was touched",
  pending: "Handed to KeeperHub; it owns nonce, gas and retries from here",
  unconfirmed: "On-chain, waiting for a receipt — KeeperHub retries and bumps gas as needed",
  completed: "Confirmed on-chain",
  failed: "KeeperHub could not land this transaction",
  cancelled: "Cancelled before it landed",
};

/** unconfirmed is deliberately NOT danger: it is the normal path of a working retry. */
function tone(s: KeeperHubStatus): "ok" | "wait" | "bad" | "muted" {
  if (s === "completed") return "ok";
  if (s === "failed") return "bad";
  if (s === "simulated" || s === "cancelled") return "muted";
  return "wait";
}

const ACTION_LABEL: Record<string, string> = {
  dry_run: "Dry run",
  execute: "Payment",
  anchor: "Cross-chain anchor",
  notify: "Notification",
};

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------

export default function KeeperHub() {
  const [status, setStatus] = useState<KeeperHubStatus_ | null>(null);
  const [workflows, setWorkflows] = useState<KeeperHubWorkflow[]>([]);
  const [executions, setExecutions] = useState<KeeperHubExecution[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Status is the only one that must succeed: it explains the other two being empty.
      const s = await api.keeperhubStatus();
      setStatus(s);
      setError(null);
      if (!s.enabled) return;
      const [w, e] = await Promise.all([
        api.keeperhubWorkflows().catch(() => ({ workflows: [] })),
        api.keeperhubExecutions(50).catch(() => ({ executions: [] })),
      ]);
      setWorkflows(w.workflows);
      setExecutions(e.executions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading) return <div className="khwrap panel khpad muted">Reading KeeperHub…</div>;

  if (error) {
    return (
      <div className="khwrap panel khpad">
        <div className="khbad">Could not reach the API: {error}</div>
      </div>
    );
  }

  if (!status?.enabled) {
    return (
      <div className="khwrap panel khpad">
        <h2 className="khh">Execution layer</h2>
        <p className="khnote">
          KeeperHub is not configured on this deployment
          {status?.disabled_reason ? <> — {status.disabled_reason}</> : null}. Payments fall back to{" "}
          <span className="mono">{status?.executor ?? "the legacy relayer"}</span>.
        </p>
      </div>
    );
  }

  const stats = status.stats_24h;
  const executed = executions.filter((x) => x.action !== "dry_run");
  const dryRuns = executions.filter((x) => x.action === "dry_run");

  return (
    <div className="khwrap">
      <Status status={status} stats={stats} />
      <Workflows workflows={workflows} />
      <Timeline
        executed={executed}
        dryRuns={dryRuns}
        open={open}
        onOpen={(id) => setOpen((cur) => (cur === id ? null : id))}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Status({ status, stats }: { status: KeeperHubStatus_; stats: KeeperHubStatus_["stats_24h"] }) {
  return (
    <section className="panel khpad">
      <div className="khhead">
        <h2 className="khh">Execution layer</h2>
        <span className="pill live">
          <b />
          KeeperHub
        </span>
      </div>
      <p className="khnote">
        AttestPay authorises; KeeperHub executes. Nonce management, gas estimation, retries and the
        audit trail below are KeeperHub&apos;s.
        {status.dry_run_required ? " Every payment must be dry-run before it can execute." : null}
      </p>

      <div className="khgrid">
        <Field label="Settlement chain" value={`${status.chain} · ${status.chain_id}`} />
        <Field label="Signing wallet" value={status.wallet ? shortHex(status.wallet, 6, 4) : "—"} title={status.wallet ?? undefined} mono />
        <Field label="Executor" value={status.executor} mono />
        <Field label="Anchoring" value={status.anchoring_via_keeperhub ? "via KeeperHub" : "direct path"} />
      </div>

      {stats ? (
        <div className="khstats">
          <Stat n={stats.by_status.completed ?? 0} label="confirmed" />
          <Stat n={stats.executions} label="executed" />
          <Stat n={stats.dry_runs} label="dry runs" />
          <Stat n={stats.by_status.failed ?? 0} label="failed" bad={(stats.by_status.failed ?? 0) > 0} />
          <span className="khstatsnote">last 24h</span>
        </div>
      ) : null}
    </section>
  );
}

function Field({ label, value, title, mono }: { label: string; value: string; title?: string; mono?: boolean }) {
  return (
    <div className="khfield">
      <span className="khlabel">{label}</span>
      <span className={mono ? "mono" : "khvalue"} title={title}>
        {value}
      </span>
    </div>
  );
}

function Stat({ n, label, bad }: { n: number; label: string; bad?: boolean }) {
  return (
    <span className={`khstat${bad ? " bad" : ""}`}>
      <b>{n}</b> {label}
    </span>
  );
}

// ---------------------------------------------------------------------------

function Workflows({ workflows }: { workflows: KeeperHubWorkflow[] }) {
  if (!workflows.length) return null;
  return (
    <section className="panel khpad">
      <h2 className="khh">Workflows</h2>
      <p className="khnote">
        Defined as code and provisioned by name, so a run executes a reviewed definition rather than
        something composed at call time.
      </p>
      <ul className="khlist">
        {workflows.map((w) => (
          <li key={w.key} className={`khwf${w.provisioned ? "" : " off"}`}>
            <div className="khwfhead">
              <span className="khwfname mono">{w.name}</span>
              {w.provisioned ? (
                <span className="khtag ok">live</span>
              ) : (
                <span className="khtag muted">not provisioned</span>
              )}
            </div>
            {w.description ? <p className="khwfdesc">{w.description.replace(/^\[keepercard\]\s*/, "")}</p> : null}
            {w.nodes?.length ? (
              <div className="khflow">
                {w.nodes.map((n, i) => (
                  <span key={n.id} className="khnode">
                    {i > 0 ? <i className="kharrow">→</i> : null}
                    <span className="khnodebox" title={n.type}>
                      {n.label}
                    </span>
                  </span>
                ))}
              </div>
            ) : null}
            {w.error ? <p className="khbad">{w.error}</p> : null}
            {w.id ? <span className="khid mono">{w.id}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

function Timeline({
  executed,
  dryRuns,
  open,
  onOpen,
}: {
  executed: KeeperHubExecution[];
  dryRuns: KeeperHubExecution[];
  open: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <section className="panel khpad">
      <div className="khhead">
        <h2 className="khh">Executions</h2>
        {dryRuns.length ? <span className="khstatsnote">{dryRuns.length} dry run(s) not shown as payments</span> : null}
      </div>
      {!executed.length ? (
        <p className="khnote">Nothing executed yet. A payment appears here the moment an agent calls `pay`.</p>
      ) : (
        <ul className="khruns">
          {executed.map((x) => (
            <Run key={x.execution_id} x={x} open={open === x.execution_id} onOpen={() => onOpen(x.execution_id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function Run({ x, open, onOpen }: { x: KeeperHubExecution; open: boolean; onOpen: () => void }) {
  const [logs, setLogs] = useState<KeeperHubLog[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || logs) return;
    setBusy(true);
    api
      .keeperhubExecution(x.execution_id)
      .then((r) => setLogs(r.logs ?? []))
      .catch(() => setLogs([]))
      .finally(() => setBusy(false));
  }, [open, logs, x.execution_id]);

  return (
    <li className="khrun">
      <button type="button" className="khrunhead" onClick={onOpen} aria-expanded={open}>
        <span className={`khdot ${tone(x.status)}`} />
        <span className="khrunwhat">
          <span className="khrunaction">{ACTION_LABEL[x.action] ?? x.action}</span>
          {x.workflow ? <span className="khrunwf mono">{x.workflow}</span> : null}
        </span>
        <span className="khrunstatus">{STATUS_LABEL[x.status] ?? x.status}</span>
        <span className="khrunwhen">{ago(x.created_at)}</span>
      </button>

      {open ? (
        <div className="khrunbody">
          <p className="khnote">{STATUS_NOTE[x.status]}</p>

          <div className="khgrid">
            {x.tx_hash ? (
              <div className="khfield">
                <span className="khlabel">Transaction</span>
                {x.tx_url ? (
                  <a className="mono khlink" href={x.tx_url} target="_blank" rel="noreferrer">
                    {shortHex(x.tx_hash, 10, 8)} ↗
                  </a>
                ) : (
                  <span className="mono">{shortHex(x.tx_hash, 10, 8)}</span>
                )}
              </div>
            ) : null}
            {x.digest ? (
              <div className="khfield">
                <span className="khlabel">Calldata digest</span>
                <span className="mono" title="Hashed at dry run, carried into execution: the bytes that ran are the bytes reviewed">
                  {shortHex(x.digest, 10, 8)}
                </span>
              </div>
            ) : null}
            {x.charge_id ? <Field label="Charge" value={x.charge_id} mono /> : null}
            <Field label="KeeperHub run" value={x.execution_id} mono />
          </div>

          {x.error ? <p className="khbad">{x.error}</p> : null}

          {busy ? <p className="khnote">Re-reading this run from KeeperHub…</p> : null}
          {logs?.length ? (
            <ol className="khlogs">
              {logs.map((l, i) => (
                <li key={`${l.node ?? i}-${i}`} className="khlog">
                  <span className={`khdot ${l.status === "completed" ? "ok" : l.status === "failed" ? "bad" : "wait"}`} />
                  <span className="khlogname">{l.node ?? "step"}</span>
                  {l.type ? <span className="khlogtype mono">{l.type}</span> : null}
                  {typeof l.duration_ms === "number" ? <span className="khlogms">{l.duration_ms}ms</span> : null}
                  {l.error ? <span className="khbad">{l.error}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
