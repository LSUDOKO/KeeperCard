// KeeperHub spans, metrics and logs. One span per hop of the execution layer, so a
// payment can be followed from the dry run to the verified receipt:
//
//   keeperhub.dry_run          simulate the exact redemption bytes from the org wallet
//   keeperhub.execute          broadcast through a workflow or direct execution
//   keeperhub.execution_poll   one status read against KeeperHub's verified receipts
//
// Two failure domains stay distinguishable in the audit log: `refusal_reason`
// (KeeperCard policy said no) vs `keeperhub_execution_failed` (policy said yes, the
// execution layer could not land it).

import { metrics, trace, type Span } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const tracer = trace.getTracer("keepercard-keeperhub");
const meter = metrics.getMeter("keepercard-keeperhub");
const logger = logs.getLogger("keepercard-keeperhub");

export const keeperhubExecutionsTotal = meter.createCounter("keeperhub.executions_total", {
  description: "KeeperHub executions started, by workflow and surface",
});

export const keeperhubDryRunsTotal = meter.createCounter("keeperhub.dry_runs_total", {
  description: "KeeperHub dry runs, by outcome",
});

export const keeperhubFailuresTotal = meter.createCounter("keeperhub.execution_failures_total", {
  description: "KeeperHub executions that ended failed, by workflow",
});

export const keeperhubRetriesTotal = meter.createCounter("keeperhub.retries_total", {
  description: "Retries KeeperHub reported performing for a direct execution",
});

export const keeperhubExecutionLatency = meter.createHistogram("keeperhub.execution_latency_ms", {
  description: "Wall time from broadcast request to a terminal KeeperHub status",
  unit: "ms",
});

export type SpanAttrs = Record<string, string | number | boolean>;

export async function traceKeeperHub<T>(
  name: "dry_run" | "execute" | "execution_poll" | "provision" | "hook",
  attrs: SpanAttrs,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`keeperhub.${name}`, async (span) => {
    for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
    try {
      const out = await fn(span);
      span.end();
      return out;
    } catch (e) {
      span.recordException(e as Error);
      span.setStatus({ code: 2, message: e instanceof Error ? e.message : String(e) });
      span.end();
      throw e;
    }
  });
}

export function emitKeeperHubExecutionFailed(args: {
  executionId: string | null;
  workflow: string;
  reason: string;
  cardId?: string | null;
  chargeId?: string | null;
}): void {
  keeperhubFailuresTotal.add(1, { workflow: args.workflow });
  logger.emit({
    severityNumber: 17,
    severityText: "ERROR",
    body: `keeperhub_execution_failed: ${args.workflow} ${args.executionId ?? "(no execution)"}: ${args.reason}`,
    attributes: {
      event: "keeperhub_execution_failed",
      keeperhub_execution_id: args.executionId ?? "",
      keeperhub_workflow: args.workflow,
      keeperhub_failure_reason: args.reason,
      card_id: args.cardId ?? "",
      charge_id: args.chargeId ?? "",
    },
  });
}

export function emitKeeperHubLog(event: string, attrs: SpanAttrs): void {
  logger.emit({
    severityNumber: 9,
    severityText: "INFO",
    body: `keeperhub ${event}`,
    attributes: { event: `keeperhub_${event}`, ...attrs },
  });
}
