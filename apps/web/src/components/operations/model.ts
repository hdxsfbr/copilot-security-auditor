import { isRecord } from "../../api/client.js";

export type OperationsDiagnostic = { code: string; level: "warning" | "info" };
export type OperationsWorker = { id: string; state: "idle" | "busy" | "no_recent_heartbeat"; startedAt: string; heartbeatAgeSeconds: number; activeRunId: string | null; diagnosticCode: string | null };
export type OperationsHealth = {
  v: 1;
  status: "ok" | "attention";
  checkedAt: string;
  policy: { heartbeatIntervalSeconds: number; freshSeconds: number; queueWarningSeconds: number };
  workerSummary: { state: "none_registered" | "no_recent_heartbeat" | "fresh"; freshCount: number; idleCount: number; busyCount: number };
  workers: OperationsWorker[];
  queue: { queuedCount: number; oldestQueuedAgeSeconds: number | null };
  leases: { activeCount: number; expiredCount: number };
  diagnostics: OperationsDiagnostic[];
};

const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const isWorker = (value: unknown): value is OperationsWorker => isRecord(value) && text(value.id) && (value.state === "idle" || value.state === "busy" || value.state === "no_recent_heartbeat") && text(value.startedAt) && count(value.heartbeatAgeSeconds) && (value.activeRunId === null || text(value.activeRunId)) && (value.diagnosticCode === null || text(value.diagnosticCode));
export const isOperationsHealth = (value: unknown): value is OperationsHealth => isRecord(value) && value.v === 1 && (value.status === "ok" || value.status === "attention") && text(value.checkedAt)
  && isRecord(value.policy) && count(value.policy.heartbeatIntervalSeconds) && count(value.policy.freshSeconds) && count(value.policy.queueWarningSeconds)
  && isRecord(value.workerSummary) && (value.workerSummary.state === "none_registered" || value.workerSummary.state === "no_recent_heartbeat" || value.workerSummary.state === "fresh") && count(value.workerSummary.freshCount) && count(value.workerSummary.idleCount) && count(value.workerSummary.busyCount)
  && Array.isArray(value.workers) && value.workers.every(isWorker)
  && isRecord(value.queue) && count(value.queue.queuedCount) && (value.queue.oldestQueuedAgeSeconds === null || count(value.queue.oldestQueuedAgeSeconds))
  && isRecord(value.leases) && count(value.leases.activeCount) && count(value.leases.expiredCount)
  && Array.isArray(value.diagnostics) && value.diagnostics.every(item => isRecord(item) && text(item.code) && (item.level === "warning" || item.level === "info"));

export function formatAge(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}

// The UI owns all diagnostic prose. The API sends only fixed codes, so raw
// server text can never reach the page; an unknown code gets generic copy.
export function diagnosticCopy(code: string, policy: OperationsHealth["policy"]): { title: string; action: string } {
  switch (code) {
    case "no_worker_registered": return { title: "No worker has registered.", action: "Start the worker service. Queued evaluations cannot start until a worker sends a heartbeat." };
    case "worker_heartbeat_stale": return { title: "No recent worker heartbeat.", action: `The newest heartbeat is older than ${policy.freshSeconds} s. The worker may have stopped or lost its database connection; this page cannot tell which. Check the worker service and its logs.` };
    case "queue_aging": return { title: "A queued evaluation has waited longer than expected.", action: `It has been queued over ${policy.queueWarningSeconds} s and no busy worker explains the wait. Confirm the worker service is running and check its logs.` };
    case "queue_waiting_for_worker_capacity": return { title: "Queued evaluations are waiting for a busy worker.", action: "Each worker process runs one evaluation at a time, so this is normal capacity, not a fault. Start another worker process to run more evaluations at once." };
    case "expired_lease": return { title: "A running evaluation's lease has expired.", action: "Its worker stopped refreshing it. The next worker cycle records it incomplete (never safe) and releases the target; if no worker is running, start one." };
    case "worker_cycle_failed": return { title: "A worker's last cycle failed.", action: "Details are deliberately not shown here. Check the worker logs; this clears after the next successful cycle." };
    case "lease_lost": return { title: "A worker lost an evaluation lease.", action: "The lease expired or was taken over mid-run. The evaluation is recorded incomplete, never safe. Check the worker logs; this clears after the next successful cycle." };
    default: return { title: "Unrecognised diagnostic.", action: "Reload the page. If it persists, check the API and worker versions match." };
  }
}
