"use client";

// The execution pane: what KeeperHub actually did with this account's money.
//
// KeeperCard decides what may be spent. KeeperHub moves it. This pane is the second
// half — and like the rest of the dashboard, it is built around not overclaiming:
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
//   5. Unknown is not zero. A balance or price that could not be read renders as
//      "unknown" — never as 0, never as healthy.

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type AttestationReport,
  type KeeperHubExecution,
  type KeeperHubLog,
  type KeeperHubStatus,
  type KeeperHubStatus_,
  type KeeperHubWorkflow,
  type Receipt,
  type ReceiptState,
  type Treasury,
} from "@/lib/api";
import { shortHex } from "./ui";

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<KeeperHubStatus, string> = {
  simulated: "Dry run passed",
  simulation_failed: "Dry run caught it",
  pending: "Submitting",
  running: "Running",
  unconfirmed: "Awaiting confirmation",
  completed: "Confirmed",
  failed: "Failed",
};

/** What each state means for the money, in the user's terms. */
const STATUS_NOTE: Record<KeeperHubStatus, string> = {
  simulated: "Rehearsed against KeeperHub's simulator — no chain was touched, no gas spent",
  simulation_failed: "The dry run reverted, so nothing was broadcast. This is the gate working: the failure cost no gas",
  pending: "Handed to KeeperHub; it owns nonce, gas and retries from here",
  running: "KeeperHub is working through the workflow's steps",
  unconfirmed: "On-chain, waiting for a receipt — KeeperHub retries and bumps gas as needed",
  completed: "Confirmed on-chain",
  failed: "KeeperHub could not land this transaction",
};

/**
 * `unconfirmed` is deliberately not danger: it is the normal path of a working retry.
 * `simulation_failed` is muted rather than red for the same reason — a dry run that
 * refuses to broadcast is the gate succeeding, not the payment failing.
 */
function tone(s: KeeperHubStatus): "ok" | "wait" | "bad" | "muted" {
  if (s === "completed") return "ok";
  if (s === "failed") return "bad";
  if (s === "simulated" || s === "simulation_failed") return "muted";
  return "wait";
}

const ACTION_LABEL: Record<string, string> = {
  dry_run: "Dry run",
  execute: "Payment",
  anchor: "On-chain receipt",
  notify: "Notification",
  reconcile: "Stuck-charge recovery",
  settle_sweep: "Fiat settlement",
  bootstrap: "Account upgrade (EIP-7702)",
};

const TRIGGER_LABEL: Record<string, string> = {
  Manual: "per payment",
  Schedule: "scheduled",
  Event: "on-chain event",
  Block: "every N blocks",
};

const RECEIPT_LABEL: Record<ReceiptState, string> = {
  anchored: "Receipt on-chain",
  anchoring: "Writing receipt",
  pending: "Receipt queued",
  failed: "Receipt failed",
  not_anchorable: "No receipt",
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
  const [attestation, setAttestation] = useState<AttestationReport | null>(null);
  const [treasury, setTreasury] = useState<Treasury | null>(null);
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      // Status is the only one that must succeed: it explains the other two being empty.
      const s = await api.keeperhubStatus();
      setStatus(s);
      setError(null);
      if (!s.enabled) return;
      const [w, e, a, t, r] = await Promise.all([
        api.keeperhubWorkflows().catch(() => ({ workflows: [] })),
        api.keeperhubExecutions(50).catch(() => ({ executions: [] })),
        // operator-only, and the chain read can be slow: absent is fine, not an error
        api.keeperhubAttestation().catch(() => null),
        api.keeperhubTreasury().catch(() => null),
        api.keeperhubReceipts().catch(() => null),
      ]);
      setWorkflows(w.workflows);
      setExecutions(e.executions);
      setAttestation(a);
      setTreasury(t);
      setReceipts(r && r.configured ? r.items : null);
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
  // Split on what happened, not on what was asked for: an anchor whose dry run reverted
  // is a rehearsal too, and listing it as a payment would overstate what touched a chain.
  const isRehearsal = (x: KeeperHubExecution) => x.status === "simulated" || x.status === "simulation_failed";
  const executed = executions.filter((x) => !isRehearsal(x));
  const dryRuns = executions.filter(isRehearsal);

  return (
    <div className="khwrap">
      <Status status={status} stats={stats} />
      <TreasuryPanel treasury={treasury} />
      <Workflows workflows={workflows} />
      <Timeline
        executed={executed}
        dryRuns={dryRuns}
        open={open}
        onOpen={(id) => setOpen((cur) => (cur === id ? null : id))}
      />
      <Receipts receipts={receipts} />
      <Attestation report={attestation} />
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
        KeeperCard authorises; KeeperHub executes. Nonce management, gas estimation, retries and the
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
      <div className="khhead">
        <h2 className="khh">Workflows</h2>
        <span className="khstatsnote">
          {workflows.filter((w) => w.provisioned).length} of {workflows.length} live on KeeperHub
        </span>
      </div>
      <p className="khnote">
        Defined as code and provisioned by name, so a run executes a reviewed definition rather than
        something composed at call time. KeeperCard starts the manual ones per payment; the rest run on
        KeeperHub&apos;s own schedule, or are started by the chain itself.
      </p>
      <ul className="khlist">
        {workflows.map((w) => (
          <li key={w.key} className={`khwf${w.provisioned ? "" : " off"}`}>
            <div className="khwfhead">
              <span className="khwfname mono">{w.name}</span>
              {w.trigger ? <span className="khtag">{TRIGGER_LABEL[w.trigger] ?? w.trigger}</span> : null}
              {w.provisioned ? (
                <span className="khtag ok">{w.enabled === false ? "provisioned" : "live"}</span>
              ) : (
                <span className="khtag muted">unavailable</span>
              )}
            </div>
            {!w.provisioned && w.unavailable_reason ? <p className="khnote">{w.unavailable_reason}</p> : null}
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
  open: number | null;
  onOpen: (id: number) => void;
}) {
  return (
    <section className="panel khpad">
      <div className="khhead">
        <h2 className="khh">Executions</h2>
      </div>
      {!executed.length ? (
        <p className="khnote">Nothing executed yet. A payment appears here the moment an agent calls `pay`.</p>
      ) : (
        <ul className="khruns">
          {executed.map((x) => (
            <Run key={x.id} x={x} open={open === x.id} onOpen={() => onOpen(x.id)} />
          ))}
        </ul>
      )}

      {dryRuns.length ? (
        <>
          <h3 className="khsub">Dry runs</h3>
          <p className="khnote">
            Rehearsals against KeeperHub&apos;s simulator. None of these touched a chain or spent gas —
            a dry run that reverts here is a payment that never had to fail on-chain.
          </p>
          <ul className="khruns">
            {dryRuns.map((x) => (
              <Run key={x.id} x={x} open={open === x.id} onOpen={() => onOpen(x.id)} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function Run({ x, open, onOpen }: { x: KeeperHubExecution; open: boolean; onOpen: () => void }) {
  const [logs, setLogs] = useState<KeeperHubLog[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // A dry run never reached KeeperHub as a run, so it has no id and no step logs.
    if (!open || logs || !x.execution_id) return;
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

      {/* The hash is the evidence — it belongs on the row, not only behind a click. */}
      {x.tx_hash && !open ? (
        <div className="khruntx">
          {x.tx_url ? (
            <a className="mono khlink" href={x.tx_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
              {shortHex(x.tx_hash, 10, 8)} ↗
            </a>
          ) : (
            <span className="mono">{shortHex(x.tx_hash, 10, 8)}</span>
          )}
        </div>
      ) : null}

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
            {x.execution_id ? <Field label="KeeperHub run" value={x.execution_id} mono /> : null}
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

// ---------------------------------------------------------------------------

/**
 * The audit trail's independent witness.
 *
 * Everything above reports what KeeperCard believes. This panel reports what the chain
 * holds, and the difference. The honesty rule here is the window: the scan is bounded,
 * so an anchor older than `from_block` was never looked at — "unwitnessed" is stated as
 * "no event in this range", never as "did not happen".
 */
function Attestation({ report }: { report: AttestationReport | null }) {
  if (!report) return null;

  if (report.error) {
    return (
      <section className="panel khpad">
        <h2 className="khh">Chain attestation</h2>
        <p className="khbad">Could not read the chain: {report.error}</p>
        <p className="khnote">No claim is made either way while the chain cannot be read.</p>
      </section>
    );
  }

  const { matched, unwitnessed, unrecorded } = report;
  const clean = unwitnessed.length === 0 && unrecorded.length === 0;

  return (
    <section className="panel khpad">
      <div className="khhead">
        <h2 className="khh">Chain attestation</h2>
        {clean ? <span className="khtag ok">reconciled</span> : <span className="khtag">discrepancies</span>}
      </div>
      <p className="khnote">
        Anchor records checked against the <span className="mono">PaymentAnchored</span> events the
        chain actually holds, read back through KeeperHub. Blocks{" "}
        <span className="mono">{report.from_block ?? "?"}</span>–<span className="mono">{report.to_block ?? "?"}</span> on
        chain {report.chain_id}.
      </p>

      <div className="khstats">
        <Stat n={matched.length} label="confirmed by the chain" />
        <Stat n={unwitnessed.length} label="not in this window" />
        <Stat n={unrecorded.length} label="on-chain, unrecorded" bad={unrecorded.length > 0} />
      </div>

      {matched.length ? (
        <>
          <h3 className="khsub">Confirmed on-chain</h3>
          <ul className="khruns">
            {matched.map((m) => (
              <li key={m.tx_hash ?? `${m.block_number}`} className="khrun">
                <div className="khrunhead" style={{ cursor: "default" }}>
                  <span className="khdot ok" />
                  <span className="khrunwhat">
                    <span className="khrunaction">{m.memo || "Payment anchor"}</span>
                    <span className="khrunwf mono">block {m.block_number ?? "?"}</span>
                  </span>
                  <span className="khrunstatus mono">{m.amount ? `${Number(m.amount) / 1e6} USDC` : "—"}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {unrecorded.length ? (
        <>
          <h3 className="khsub">On-chain, but not in KeeperCard&apos;s books</h3>
          <p className="khnote">
            The chain holds these anchors and KeeperCard has no record of them — a run whose result
            never made it home. This is the direction worth investigating.
          </p>
          <ul className="khruns">
            {unrecorded.map((m) => (
              <li key={m.tx_hash ?? `${m.block_number}`} className="khrun">
                <div className="khrunhead" style={{ cursor: "default" }}>
                  <span className="khdot bad" />
                  <span className="khrunwhat">
                    <span className="khrunaction mono">{shortHex(m.tx_hash, 10, 8)}</span>
                    <span className="khrunwf mono">block {m.block_number ?? "?"}</span>
                  </span>
                  <span className="khrunstatus mono">{m.amount ? `${Number(m.amount) / 1e6} USDC` : "—"}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {unwitnessed.length ? (
        <>
          <h3 className="khsub">No event in the scanned range</h3>
          <p className="khnote">
            KeeperCard recorded these as landed, and no matching event appears between blocks{" "}
            {report.from_block ?? "?"} and {report.to_block ?? "?"}. An anchor older than that window
            was simply not scanned, so this is not by itself a discrepancy.
          </p>
          <ul className="khruns">
            {unwitnessed.map((u) => (
              <li key={u.execution_id ?? u.tx_hash ?? u.created_at} className="khrun">
                <div className="khrunhead" style={{ cursor: "default" }}>
                  <span className="khdot wait" />
                  <span className="khrunwhat">
                    <span className="khrunaction mono">{shortHex(u.tx_hash, 10, 8)}</span>
                    {u.charge_id ? <span className="khrunwf mono">{u.charge_id}</span> : null}
                  </span>
                  <span className="khrunwhen">{ago(u.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------

/**
 * What payments depend on, read live through KeeperHub. The honesty rule is rule 5: a
 * figure that could not be read is shown as unknown. A treasury panel that renders a
 * failed read as "0.00" invents an emergency; one that renders it as fine hides one.
 */
function TreasuryPanel({ treasury }: { treasury: Treasury | null }) {
  if (!treasury) return null;
  const price = (q: Treasury["usdc_usd"], digits: number) => (q ? `$${q.price.toFixed(digits)}` : "unknown");
  return (
    <section className="panel khpad">
      <div className="khhead">
        <h2 className="khh">Treasury</h2>
        {treasury.usdc_depegged === true ? (
          <span className="khtag bad">USDC below peg · payments refused</span>
        ) : treasury.usdc_depegged === false ? (
          <span className="khtag ok">USDC on peg</span>
        ) : (
          <span className="khtag muted">peg unknown</span>
        )}
      </div>
      <p className="khnote">
        Read live through KeeperHub on {treasury.chain}. Cards are written in USDC, so the dry run refuses
        a payment when Chainlink&apos;s USDC/USD reads below {treasury.depeg_floor ?? "the floor"} — and
        refuses nothing when the feed cannot be read.
      </p>
      <div className="khgrid">
        <Field label="USDC / USD (Chainlink)" value={price(treasury.usdc_usd, 4)} />
        <Field label="ETH / USD (Chainlink)" value={price(treasury.eth_usd, 2)} />
        {treasury.guarded_min_usdc ? <Field label="Risk-guarded from" value={`${treasury.guarded_min_usdc} USDC`} /> : null}
      </div>
      <ul className="khlist">
        {treasury.wallets.map((w) => (
          <li key={w.address} className="khwf">
            <div className="khwfhead">
              <span className="khwfname">{w.role}</span>
              {w.gas_low ? <span className="khtag bad">gas low</span> : null}
            </div>
            <div className="khgrid">
              <Field label="Address" value={shortHex(w.address, 6, 4)} title={w.address} mono />
              <Field label="Gas" value={w.gas_eth === null ? "unknown" : `${w.gas_eth} ETH`} />
              <Field label="USDC" value={w.usdc === null ? "unknown" : `${w.usdc} USDC`} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------

/** A payment and the public record of it, side by side, each one a link. */
function Receipts({ receipts }: { receipts: Receipt[] | null }) {
  if (!receipts) return null;
  return (
    <section className="panel khpad">
      <div className="khhead">
        <h2 className="khh">On-chain receipts</h2>
        <span className="khstatsnote">
          {receipts.filter((r) => r.state === "anchored").length} of {receipts.length} anchored
        </span>
      </div>
      <p className="khnote">
        After a payment confirms, KeeperHub writes a PaymentAnchor record on the same chain. The ledger
        below is a claim; the receipt is a public event anyone can read. It is written in the background,
        so a queued receipt right after a payment is normal.
      </p>
      {!receipts.length ? (
        <p className="khnote">No confirmed payments yet.</p>
      ) : (
        <ul className="khruns">
          {receipts.map((r) => (
            <li key={r.charge_id} className="khrun">
              <div className="khrunhead" style={{ cursor: "default" }}>
                <span className={`khdot ${r.state === "anchored" ? "ok" : r.state === "failed" ? "bad" : r.state === "not_anchorable" ? "muted" : "wait"}`} />
                <span className="khrunwhat">
                  <span className="khrunaction">{r.memo || "Payment"}</span>
                  <span className="khrunwf mono">{r.amount} USDC</span>
                </span>
                <span className="khrunstatus">{RECEIPT_LABEL[r.state]}</span>
              </div>
              <div className="khruntx">
                {r.payment_tx ? (
                  <a className="mono khlink" href={r.payment_url ?? undefined} target="_blank" rel="noreferrer">
                    payment {shortHex(r.payment_tx, 8, 6)} ↗
                  </a>
                ) : null}
                {r.anchor_tx ? (
                  <a className="mono khlink" href={r.anchor_url ?? undefined} target="_blank" rel="noreferrer" style={{ marginLeft: 14 }}>
                    receipt {shortHex(r.anchor_tx, 8, 6)} ↗
                  </a>
                ) : null}
                {r.state === "failed" && r.error ? <span className="khbad" style={{ marginLeft: 14 }}>{r.error}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
