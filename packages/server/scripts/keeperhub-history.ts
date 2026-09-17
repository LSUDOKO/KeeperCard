// Prints KeeperHub's OWN execution history for every KeeperCard workflow: the figures
// here come from KeeperHub, not from KeeperCard's ledger.
//   bun run --cwd packages/server keeperhub:history

import { keeperhub } from "@attestpay/engine";

const config = keeperhub.keeperhubConfig();
if (!config) {
  console.error("KEEPERHUB_API_KEY is not set");
  process.exit(1);
}
const client = new keeperhub.KeeperHubClient(config);
const names = new Set<string>(Object.values(keeperhub.KEEPERHUB_WORKFLOW_NAMES));
const workflows = (await client.listWorkflows()).filter((w) => names.has(w.name));

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`${pad("WORKFLOW", 28)}${pad("TRIGGER", 10)}${pad("RUNS", 6)}${pad("OK", 5)}${pad("LAST RUN (UTC)", 21)}OTHER`);
let total = 0;
let succeeded = 0;
for (const key of keeperhub.KEEPERHUB_WORKFLOW_KEYS) {
  const wf = workflows.find((w) => w.name === keeperhub.KEEPERHUB_WORKFLOW_NAMES[key]);
  if (!wf) continue;
  const runs = await client.listWorkflowExecutions(wf.id).catch(() => []);
  const ok = runs.filter((r) => r.status === "success").length;
  const last = runs.map((r) => r.startedAt ?? "").sort().at(-1) ?? "";
  const other = new Map<string, number>();
  for (const r of runs) if (r.status !== "success") other.set(r.status, (other.get(r.status) ?? 0) + 1);
  const otherText = [...other].map(([status, n]) => `${n} ${status}`).join(", ");
  total += runs.length;
  succeeded += ok;
  console.log(`${pad(wf.name, 28)}${pad(keeperhub.KEEPERHUB_WORKFLOW_TRIGGERS[key], 10)}${pad(String(runs.length), 6)}${pad(String(ok), 5)}${pad(last ? last.replace("T", " ").slice(0, 19) : "—", 21)}${otherText}`);
}
console.log(`\n${total} runs · ${succeeded} succeeded · source: app.keeperhub.com/api`);
