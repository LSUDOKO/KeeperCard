// KeeperHub REST client. Every shape here is taken from KeeperHub's own route code
// (app/api/execute/*, app/api/workflow*/**), not from memory; docs/keeperhub/api-notes.md
// records where the docs and the code disagree.
//
// Retry policy mirrors KeeperHub's own guidance for direct execution:
//   - reads retry on network errors, 429 and 5xx with exponential backoff
//   - writes retry ONLY when they carry an Idempotency-Key (a replay returns the
//     original execution instead of broadcasting twice) and never on a 409 conflict
//   - `unconfirmed` is not a failure: callers keep polling, they never re-send

import type { Address, Hex } from "viem";
import type { KeeperHubConfig } from "./config";

export type KeeperHubChain = {
  id: string;
  chainId: number;
  name: string;
  symbol: string;
  chainType: "evm" | "solana";
  explorerUrl: string | null;
  isTestnet: boolean;
  isEnabled: boolean;
  usePrivateMempoolRpc: boolean;
};

/** Feature id KeeperHub uses for the Pro-gated `HTTP Request` action. */
export const HTTP_REQUEST_FEATURE_ID = "action.http-request";

export type KeeperHubFeatures = {
  /** "free", "pro", ... */
  plan: string;
  /** Feature ids this org may actually put in a workflow. */
  usableFeatureIds: ReadonlySet<string>;
};

export type KeeperHubIntegration = {
  id: string;
  name: string;
  type: string;
  address?: string | null;
  isManaged?: boolean;
};

export type WorkflowNode = {
  id: string;
  type: "trigger" | "action";
  position?: { x: number; y: number };
  data: { label: string; description?: string; type?: string; config: Record<string, unknown> };
};

export type WorkflowEdge = { id: string; source: string; target: string; sourceHandle?: string; type?: string };

export type WorkflowDefinition = {
  name: string;
  description?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  enabled?: boolean;
};

export type KeeperHubWorkflow = WorkflowDefinition & {
  id: string;
  enabled?: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type ContractCallRequest = {
  contractAddress: Address;
  chainId: number;
  /** raw calldata; mutually exclusive with functionName/functionArgs */
  data?: Hex;
  functionName?: string;
  functionArgs?: string;
  abi?: string;
  value?: string;
  gasLimitMultiplier?: string;
  priorityFeeGwei?: string;
  simulate?: boolean;
};

export type SimulationResult = {
  success: boolean;
  wouldRevert: boolean;
  from: Address | null;
  to: Address | null;
  gasEstimate: string | null;
  revertReason: string | null;
  error: string | null;
  failureKind: string | null;
  code: string | null;
  raw: unknown;
};

export type DirectExecutionStatus = "pending" | "running" | "unconfirmed" | "completed" | "failed";

export type DirectExecution = {
  executionId: string;
  status: DirectExecutionStatus;
  transactionHash: Hex | null;
  transactionLink: string | null;
  error: string | null;
  idempotentReplay: boolean;
};

export type DirectExecutionReceipt = {
  hash: Hex;
  chainId: number | null;
  verified: boolean;
  receiptStatus: string | null;
  blockNumber: number | null;
  gasUsed: string | null;
};

export type DirectExecutionDetail = DirectExecution & {
  type: string | null;
  network: string | null;
  sponsored: boolean;
  retryCount: number;
  receipts: DirectExecutionReceipt[];
  gasUsedWei: string | null;
  estimatedCostUsd: string | null;
  createdAt: string | null;
  completedAt: string | null;
  pollIntervalHint: number | null;
};

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "unconfirmed"
  | "success"
  | "error"
  | "skipped"
  | "cancelled"
  | "phantom"
  | "system_error";

export type WorkflowTxHash = {
  hash: Hex;
  nodeId: string;
  nodeName: string;
  chainId?: number;
  network?: string;
  verified?: boolean;
  receiptStatus?: string;
  blockNumber?: number;
  gasUsed?: string;
};

export type WorkflowExecutionStatus = {
  executionId: string;
  status: WorkflowRunStatus;
  nodeStatuses: Array<{ nodeId: string; status: string }>;
  progress: { totalSteps: number; completedSteps: number; percentage: number; currentNodeName?: string | null } | null;
  errorContext: unknown;
  transactionHashes: WorkflowTxHash[];
  pollIntervalHint: number | null;
};

export type WorkflowExecutionLog = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  duration: number | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type WorkflowExecutionRow = {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  startedAt?: string;
  completedAt?: string | null;
  error?: string | null;
  totalSteps?: number;
  completedSteps?: number;
};

export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
  "success",
  "error",
  "system_error",
  "skipped",
  "cancelled",
]);

export class KeeperHubError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly httpStatus: number | null,
    readonly code: string | null,
    readonly retryable: boolean,
    readonly body: unknown = null,
  ) {
    super(`keeperhub ${operation}: ${message}`);
    this.name = "KeeperHubError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type KeeperHubClientOptions = {
  fetch?: FetchLike;
  /** attempts including the first (default 4) */
  maxAttempts?: number;
  /** base backoff (default 400ms, doubling, capped at 8s) */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  /** statuses that carry a meaningful JSON body and must not throw (e.g. a 400 simulated revert) */
  acceptStatuses?: number[];
};

type RawResponse = { status: number; json: unknown; headers: Headers };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export class KeeperHubClient {
  private readonly fetchImpl: FetchLike;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(
    readonly config: Pick<KeeperHubConfig, "apiKey" | "apiBase">,
    opts: KeeperHubClientOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.backoffMs = opts.backoffMs ?? 400;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  // ---------------------------------------------------------------------------
  // transport
  // ---------------------------------------------------------------------------

  private async request(operation: string, path: string, opts: RequestOptions = {}): Promise<RawResponse> {
    const method = opts.method ?? "GET";
    const url = `${this.config.apiBase}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      accept: "application/json",
      "user-agent": "keepercard-attestpay/1.0",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    // a write without an idempotency key is sent exactly once: retrying it could
    // broadcast a second transaction for work the first attempt already did
    const canRetry = method === "GET" || !!opts.idempotencyKey;

    let lastError: KeeperHubError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastError = new KeeperHubError(operation, `network error: ${e instanceof Error ? e.message : String(e)}`, null, "network", true);
        if (!canRetry || attempt === this.maxAttempts) throw lastError;
        await this.sleep(this.backoff(attempt, null));
        continue;
      }

      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
      }
      if (res.ok || opts.acceptStatuses?.includes(res.status)) {
        return { status: res.status, json, headers: res.headers };
      }

      const body = asRecord(json);
      const code = str(body.code);
      const message = str(body.error) ?? str(body.message) ?? (typeof json === "string" ? json.slice(0, 300) : `http ${res.status}`);
      // idempotency_in_progress is explicitly retryable with the SAME key; a conflict never is
      const retryable =
        code === "idempotency_in_progress" ||
        (code !== "idempotency_conflict" && (res.status === 429 || res.status >= 500));
      lastError = new KeeperHubError(operation, message, res.status, code, retryable, json);
      if (!retryable || !canRetry || attempt === this.maxAttempts) throw lastError;
      await this.sleep(this.backoff(attempt, res.headers.get("retry-after")));
    }
    throw lastError ?? new KeeperHubError(operation, "exhausted retries", null, null, true);
  }

  private backoff(attempt: number, retryAfter: string | null): number {
    const hinted = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(hinted) && hinted >= 0) return Math.min(hinted * 1000, 30_000);
    return Math.min(this.backoffMs * 2 ** (attempt - 1), 8_000);
  }

  // ---------------------------------------------------------------------------
  // platform
  // ---------------------------------------------------------------------------

  async listChains(): Promise<KeeperHubChain[]> {
    const { json } = await this.request("list_chains", "/chains");
    return Array.isArray(json) ? (json as KeeperHubChain[]) : [];
  }

  /** Bare array in code (the docs show a {data} wrapper; both are accepted). */
  async listIntegrations(type?: string): Promise<KeeperHubIntegration[]> {
    const { json } = await this.request("list_integrations", `/integrations${type ? `?type=${encodeURIComponent(type)}` : ""}`);
    if (Array.isArray(json)) return json as KeeperHubIntegration[];
    const data = asRecord(json).data;
    return Array.isArray(data) ? (data as KeeperHubIntegration[]) : [];
  }

  /** The org's Turnkey signing wallet: msg.sender of every KeeperHub write. */
  async walletAddress(): Promise<Address | null> {
    const web3 = await this.listIntegrations("web3");
    const hit = web3.find((i) => typeof i.address === "string" && /^0x[0-9a-fA-F]{40}$/.test(i.address));
    return (hit?.address as Address | undefined) ?? null;
  }

  async spendCap(): Promise<Record<string, unknown>> {
    const { json } = await this.request("spend_cap", "/analytics/spend-cap");
    return asRecord(json);
  }

  /**
   * The org's plan and which gated features it may actually use.
   *
   * A feature is usable when it names no `requiredPlan`, or when the org has bought
   * it (`enabledFeatureIds`). Note `enabled` on a feature means "this build ships it",
   * not "this org may use it" — on a free org every Pro feature still reads
   * `enabled: true` with `requiredPlan: "pro"`, so reading `enabled` alone would let
   * a workflow through that the API then rejects with 402 upgrade_required.
   */
  async features(): Promise<KeeperHubFeatures> {
    const { json } = await this.request("features", "/features");
    const rec = asRecord(json);
    const owned = new Set((Array.isArray(rec.enabledFeatureIds) ? rec.enabledFeatureIds : []).map(String));
    const usable = new Set<string>();
    for (const raw of Array.isArray(rec.features) ? rec.features : []) {
      const f = asRecord(raw);
      const id = typeof f.id === "string" ? f.id : null;
      if (!id) continue;
      if (!f.requiredPlan || owned.has(id)) usable.add(id);
    }
    return { plan: typeof rec.plan === "string" ? rec.plan : "unknown", usableFeatureIds: usable };
  }

  /** Whether workflows may contain an `HTTP Request` node (Pro-gated). */
  async supportsHttpRequestAction(): Promise<boolean> {
    return (await this.features()).usableFeatureIds.has(HTTP_REQUEST_FEATURE_ID);
  }

  // ---------------------------------------------------------------------------
  // direct execution (dry run + broadcast share ONE request body)
  // ---------------------------------------------------------------------------

  async simulateContractCall(req: ContractCallRequest): Promise<SimulationResult> {
    // a simulated revert is a 400 with a structured body, an unfunded wallet a 400
    // with code insufficient_balance: both are answers, not transport failures
    const { json } = await this.request("simulate_contract_call", "/execute/contract-call", {
      method: "POST",
      body: { ...req, simulate: true },
      acceptStatuses: [400],
    });
    const r = asRecord(json);
    return {
      success: r.success === true && r.wouldRevert !== true,
      wouldRevert: r.wouldRevert === true,
      from: (str(r.from) as Address | null) ?? null,
      to: (str(r.to) as Address | null) ?? null,
      gasEstimate: r.gasEstimate === undefined || r.gasEstimate === null ? null : String(r.gasEstimate),
      revertReason: str(r.revertReason),
      error: str(r.error) ?? str(r.details),
      failureKind: str(r.failureKind),
      code: str(r.code),
      raw: json,
    };
  }

  async executeContractCall(req: ContractCallRequest, idempotencyKey: string): Promise<DirectExecution> {
    const { simulate: _ignored, ...body } = req;
    const { json } = await this.request("execute_contract_call", "/execute/contract-call", {
      method: "POST",
      body,
      idempotencyKey,
    });
    return parseDirectExecution(json);
  }

  async directExecutionStatus(executionId: string): Promise<DirectExecutionDetail> {
    const { json, headers } = await this.request(
      "direct_execution_status",
      `/execute/${encodeURIComponent(executionId)}/status`,
    );
    const r = asRecord(json);
    const receipts = Array.isArray(r.receipts) ? r.receipts : [];
    return {
      ...parseDirectExecution(json),
      type: str(r.type),
      network: str(r.network),
      sponsored: r.sponsored === true,
      retryCount: num(r.retryCount) ?? 0,
      receipts: receipts.map((x) => {
        const rc = asRecord(x);
        return {
          hash: rc.hash as Hex,
          chainId: num(rc.chainId),
          verified: rc.verified === true,
          receiptStatus: str(rc.receiptStatus),
          blockNumber: num(rc.blockNumber),
          gasUsed: rc.gasUsed === undefined || rc.gasUsed === null ? null : String(rc.gasUsed),
        };
      }),
      gasUsedWei: r.gasUsedWei === undefined || r.gasUsedWei === null ? null : String(r.gasUsedWei),
      estimatedCostUsd: r.estimatedCostUsd === undefined || r.estimatedCostUsd === null ? null : String(r.estimatedCostUsd),
      createdAt: str(r.createdAt),
      completedAt: str(r.completedAt),
      pollIntervalHint: num(headers.get("x-poll-interval-hint")),
    };
  }

  // ---------------------------------------------------------------------------
  // workflows
  // ---------------------------------------------------------------------------

  async listWorkflows(limit = 200): Promise<KeeperHubWorkflow[]> {
    const { json } = await this.request("list_workflows", `/workflows?limit=${limit}`);
    if (Array.isArray(json)) return json as KeeperHubWorkflow[];
    const data = asRecord(json).data;
    return Array.isArray(data) ? (data as KeeperHubWorkflow[]) : [];
  }

  async getWorkflow(id: string): Promise<KeeperHubWorkflow> {
    const { json } = await this.request("get_workflow", `/workflows/${encodeURIComponent(id)}`);
    return json as KeeperHubWorkflow;
  }

  async createWorkflow(def: WorkflowDefinition, idempotencyKey?: string): Promise<KeeperHubWorkflow> {
    const { json } = await this.request("create_workflow", "/workflows/create", {
      method: "POST",
      body: def,
      idempotencyKey,
    });
    return json as KeeperHubWorkflow;
  }

  async updateWorkflow(id: string, patch: Partial<WorkflowDefinition>): Promise<KeeperHubWorkflow> {
    const { json } = await this.request("update_workflow", `/workflows/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
    return json as KeeperHubWorkflow;
  }

  async validateWorkflow(id: string, deepCheck = false): Promise<Record<string, unknown>> {
    const { json } = await this.request(
      "validate_workflow",
      `/workflows/${encodeURIComponent(id)}/validate${deepCheck ? "?deepCheck=true" : ""}`,
    );
    return asRecord(json);
  }

  /** Whole-workflow dry run of the SAVED workflow (advisory, per-node). */
  async simulateWorkflow(id: string): Promise<Record<string, unknown>> {
    const { json } = await this.request("simulate_workflow", `/workflows/${encodeURIComponent(id)}/simulate`, {
      method: "POST",
      body: {},
      acceptStatuses: [400, 413, 503],
    });
    return asRecord(json);
  }

  async executeWorkflow(
    id: string,
    input: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<{ executionId: string; status: WorkflowRunStatus; idempotentReplay: boolean }> {
    const { json } = await this.request("execute_workflow", `/workflows/${encodeURIComponent(id)}/execute`, {
      method: "POST",
      body: { input },
      idempotencyKey,
    });
    const r = asRecord(json);
    const executionId = str(r.executionId);
    if (!executionId) {
      throw new KeeperHubError("execute_workflow", `response carried no executionId: ${JSON.stringify(json).slice(0, 200)}`, 200, null, false, json);
    }
    return { executionId, status: (str(r.status) ?? "running") as WorkflowRunStatus, idempotentReplay: r.idempotentReplay === true };
  }

  async workflowExecutionStatus(executionId: string): Promise<WorkflowExecutionStatus> {
    const { json, headers } = await this.request(
      "workflow_execution_status",
      `/workflows/executions/${encodeURIComponent(executionId)}/status`,
    );
    const r = asRecord(json);
    const progress = asRecord(r.progress);
    return {
      executionId,
      status: (str(r.status) ?? "pending") as WorkflowRunStatus,
      nodeStatuses: Array.isArray(r.nodeStatuses) ? (r.nodeStatuses as WorkflowExecutionStatus["nodeStatuses"]) : [],
      progress: r.progress
        ? {
            totalSteps: num(progress.totalSteps) ?? 0,
            completedSteps: num(progress.completedSteps) ?? 0,
            percentage: num(progress.percentage) ?? 0,
            currentNodeName: str(progress.currentNodeName),
          }
        : null,
      errorContext: r.errorContext ?? null,
      transactionHashes: Array.isArray(r.transactionHashes) ? (r.transactionHashes as WorkflowTxHash[]) : [],
      pollIntervalHint: num(headers.get("x-poll-interval-hint")),
    };
  }

  async workflowExecutionLogs(executionId: string): Promise<{ execution: Record<string, unknown>; logs: WorkflowExecutionLog[] }> {
    const { json } = await this.request(
      "workflow_execution_logs",
      `/workflows/executions/${encodeURIComponent(executionId)}/logs`,
    );
    const r = asRecord(json);
    return {
      execution: asRecord(r.execution),
      logs: Array.isArray(r.logs) ? (r.logs as WorkflowExecutionLog[]) : [],
    };
  }

  /** Latest 50 runs of one workflow, newest first. */
  async listWorkflowExecutions(workflowId: string): Promise<WorkflowExecutionRow[]> {
    const { json } = await this.request(
      "list_workflow_executions",
      `/workflows/${encodeURIComponent(workflowId)}/executions`,
    );
    return Array.isArray(json) ? (json as WorkflowExecutionRow[]) : [];
  }

  async cancelExecution(executionId: string): Promise<void> {
    await this.request("cancel_execution", `/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: "POST",
      body: {},
    });
  }
}

function parseDirectExecution(json: unknown): DirectExecution {
  const r = asRecord(json);
  const executionId = str(r.executionId);
  if (!executionId) {
    throw new KeeperHubError(
      "direct_execution",
      str(r.error) ?? `response carried no executionId: ${JSON.stringify(json).slice(0, 200)}`,
      null,
      str(r.code),
      false,
      json,
    );
  }
  return {
    executionId,
    status: (str(r.status) ?? "pending") as DirectExecutionStatus,
    transactionHash: (str(r.transactionHash) as Hex | null) ?? null,
    transactionLink: str(r.transactionLink),
    error: str(r.error),
    idempotentReplay: r.idempotentReplay === true,
  };
}
