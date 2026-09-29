import React, { useEffect, useRef, useState } from "react";
import { isRecord, requestJson } from "../api/client.js";
import { useWorkspace } from "../pages/context.js";

type Usage = { id: string; role: string; provider: "ollama" | "openrouter"; model: string; status: string; inputTokens: number | null; outputTokens: number | null; latencyMs: number | null; chargeNanos: string | null; reservedNanos: string; reconciled?: boolean };
type AdaptiveCase = { id: string; ordinal: number; category: string; state: string; executed: boolean; reason?: string | null };
const isUsage = (value: unknown): value is Usage => isRecord(value) && typeof value.id === "string" && typeof value.role === "string" && (value.provider === "ollama" || value.provider === "openrouter") && typeof value.model === "string" && typeof value.status === "string" && (value.inputTokens === null || typeof value.inputTokens === "number") && (value.outputTokens === null || typeof value.outputTokens === "number") && (value.latencyMs === null || typeof value.latencyMs === "number") && (value.chargeNanos === null || typeof value.chargeNanos === "string") && typeof value.reservedNanos === "string";
const isUsageList = (value: unknown): value is Usage[] => Array.isArray(value) && value.every(isUsage);
const isAdaptiveCase = (value: unknown): value is AdaptiveCase => isRecord(value) && typeof value.id === "string" && Number.isInteger(value.ordinal) && typeof value.category === "string" && typeof value.state === "string" && typeof value.executed === "boolean" && (value.reason === undefined || value.reason === null || typeof value.reason === "string");
const isAdaptiveCaseList = (value: unknown): value is AdaptiveCase[] => Array.isArray(value) && value.every(isAdaptiveCase);
const isStopResult = (value: unknown): value is { stopRequested: boolean } => isRecord(value) && typeof value.stopRequested === "boolean";
const dollars = (nanos: string) => `$${(Number(nanos) / 1e9).toFixed(9).replace(/(\.\d{6})0+$/, "$1")}`;

export function RunActivity() {
  const { run, pollRun } = useWorkspace();
  const runId = run?.id;
  const currentRunId = useRef(runId);
  currentRunId.current = runId;
  const usageSequence = useRef(0), progressSequence = useRef(0);
  const [usage, setUsage] = useState<Usage[]>([]);
  const [progress, setProgress] = useState<AdaptiveCase[]>([]);
  const [usageError, setUsageError] = useState("");
  const [progressError, setProgressError] = useState("");
  const [stopError, setStopError] = useState("");
  const [stopState, setStopState] = useState<"idle" | "pending" | "accepted">("idle");
  const loadUsage = async (id = runId) => {
    if (!id) return;
    const request = ++usageSequence.current;
    try {
      const next = await requestJson(`/runs/${id}/usage`, isUsageList);
      if (currentRunId.current === id && usageSequence.current === request) { setUsage(next); setUsageError(""); }
    } catch (cause) { if (currentRunId.current === id && usageSequence.current === request) setUsageError(cause instanceof Error ? cause.message : "Usage ledger unavailable"); }
  };
  const loadProgress = async (id = runId) => {
    if (!id) return;
    const request = ++progressSequence.current;
    try {
      const next = await requestJson(`/runs/${id}/cases`, isAdaptiveCaseList);
      if (currentRunId.current === id && progressSequence.current === request) { setProgress(next); setProgressError(""); }
    } catch (cause) { if (currentRunId.current === id && progressSequence.current === request) setProgressError(cause instanceof Error ? cause.message : "Adaptive progress unavailable"); }
  };
  useEffect(() => {
    setUsage([]); setProgress([]); setUsageError(""); setProgressError(""); setStopError(""); setStopState("idle");
    if (!runId) return;
    void loadUsage(runId); void loadProgress(runId);
  }, [runId]);
  useEffect(() => {
    if (!runId || run?.status === "finished") return;
    const timer = setInterval(() => { if (!document.hidden) { void loadUsage(runId); void loadProgress(runId); } }, 1500);
    return () => clearInterval(timer);
  }, [runId, run?.status]);
  useEffect(() => { if (runId && run?.status === "finished") { void loadUsage(runId); void loadProgress(runId); } }, [runId, run?.status]);
  const requestStop = async () => {
    if (!runId || stopState !== "idle") return;
    setStopError("");
    setStopState("pending");
    try {
      await requestJson(`/runs/${runId}/stop`, isStopResult, { method: "POST" });
      if (currentRunId.current === runId) { setStopState("accepted"); void pollRun(runId); }
    } catch (cause) { if (currentRunId.current === runId) { setStopState("idle"); setStopError(cause instanceof Error ? cause.message : "Stop request failed"); } }
  };
  if (!runId || run.status === "loading") return null;
  const settled = usage.filter(call => call.provider === "openrouter" && call.status === "settled").reduce((total, call) => total + Number(call.chargeNanos ?? 0), 0);
  return <section className="panel run-activity" aria-label="Run activity">
    {run.status !== "finished" && <div className="usage-ledger"><h2>Run control</h2><button type="button" disabled={stopState !== "idle" || !!run.stopRequested} onClick={() => void requestStop()}>{stopState === "pending" ? "Requesting stop…" : stopState === "accepted" || run.stopRequested ? "Stop requested" : "Stop after in-flight work"}</button>{stopError && <p role="alert">{stopError}</p>}<p className="hint">Queued work stops before dispatch. Running work stops after the in-flight operation; an incomplete run is never a pass.</p></div>}
    {run.categories && <div className="usage-ledger"><h2>Adaptive progress</h2>
      {progressError && <p role="alert">{progressError} <button type="button" onClick={() => void loadProgress()}>Retry progress</button></p>}
      {run.categories.map(category => <p key={category}>{category.replaceAll("_", " ")}: {progress.filter(item => item.category === category).map(item => `case ${item.ordinal} ${item.state}${item.executed ? " (executed)" : " (not executed)"}`).join(" · ") || "not tested / gap"}</p>)}
      <p className="hint">A stop or time limit leaves the unfinished case incomplete; it never makes a pass.</p>
    </div>}
    <div className="usage-ledger"><h2>Measured model usage</h2>{run.status === "finished" && <button type="button" onClick={() => { void loadUsage(); void loadProgress(); }}>Refresh usage and progress</button>}
      {usageError && <p role="alert">{usageError} <button type="button" onClick={() => void loadUsage()}>Retry usage</button></p>}
      <p>Paid settled: {dollars(String(settled))} · Ollama: no dollar price assigned</p>
      {usage.length ? usage.map(call => <p key={call.id}>{call.role}: {call.provider} / {call.model} · {call.status} · {call.inputTokens ?? "?"} in / {call.outputTokens ?? "?"} out · {call.latencyMs ?? "?"} ms · {call.provider === "ollama" ? "local, unpriced" : call.status === "settled" ? `${dollars(call.chargeNanos!)}${call.reconciled ? " (operator-attested)" : ""}` : `reserved ${dollars(call.reservedNanos)}; charge unresolved`}</p>) : <p>No model calls recorded yet.</p>}
    </div>
  </section>;
}
