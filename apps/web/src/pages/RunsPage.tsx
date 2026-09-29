import React, { useEffect, useRef, useState } from "react";
import { isRecord, requestJson } from "../api/client.js";
import { RouteLink } from "../components/router.js";
import { useWorkspace } from "./context.js";

type HistoryRun = {
  id: string; mode: "selected" | "adaptive"; status: string; outcome: string | null;
  stopRequested: boolean; createdAt: string; startedAt: string | null; finishedAt: string | null;
  target: { id: string; name: string | null; version: string | null };
  caseSnapshot: { id: string; familyId: string | null; version: number | null; title: string | null } | null;
  adaptiveCategories: string[] | null; scheduleOccurrenceId: string | null;
};
type Page = { items: HistoryRun[]; nextCursor: string | null };
const text = (v: unknown): v is string => typeof v === "string";
const nullable = (v: unknown): v is string | null => v === null || text(v);
const date = (v: unknown): v is string => text(v) && !Number.isNaN(Date.parse(v));
const isRun = (v: unknown): v is HistoryRun => isRecord(v) && text(v.id) && (v.mode === "selected" || v.mode === "adaptive") && text(v.status) && nullable(v.outcome) && typeof v.stopRequested === "boolean" && date(v.createdAt) && (v.startedAt === null || date(v.startedAt)) && (v.finishedAt === null || date(v.finishedAt)) && isRecord(v.target) && text(v.target.id) && nullable(v.target.name) && nullable(v.target.version) && (v.caseSnapshot === null || (isRecord(v.caseSnapshot) && text(v.caseSnapshot.id) && nullable(v.caseSnapshot.familyId) && (v.caseSnapshot.version === null || Number.isInteger(v.caseSnapshot.version)) && nullable(v.caseSnapshot.title))) && (v.adaptiveCategories === null || (Array.isArray(v.adaptiveCategories) && v.adaptiveCategories.every(text))) && nullable(v.scheduleOccurrenceId);
const isPage = (v: unknown): v is Page => isRecord(v) && Array.isArray(v.items) && v.items.every(isRun) && nullable(v.nextCursor);
const when = (value: string | null) => value ? new Date(value).toLocaleString() : "—";

export function RunsPage() {
  const { navigate } = useWorkspace();
  const [items, setItems] = useState<HistoryRun[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const failed = useRef<{ cursor: string | null; reset: boolean } | null>(null);
  const load = async (next: string | null, reset = false) => {
    const token = ++generation.current;
    setBusy(true); setError("");
    try {
      const page = await requestJson(`/runs?limit=25${next ? `&cursor=${encodeURIComponent(next)}` : ""}`, isPage);
      if (generation.current !== token) return;
      setItems(previous => reset ? page.items : [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))]);
      setCursor(page.nextCursor); setLoaded(true);
      failed.current = null;
    } catch (cause) {
      if (generation.current === token) { failed.current = { cursor: next, reset }; setError(cause instanceof Error ? cause.message : "Run history unavailable"); }
    } finally { if (generation.current === token) setBusy(false); }
  };
  useEffect(() => { void load(null, true); return () => { generation.current++; }; }, []);
  const active = items.filter(item => item.status !== "finished");
  return <section className="panel run-history" aria-label="Run history">
    <div className="run-history-head"><div><div className="eyebrow">SAVED ACTIVITY</div><h2>Run history</h2></div><button type="button" onClick={() => void load(null, true)} disabled={busy}>Refresh history</button></div>
    <p className="hint">Runs are saved on the server. The newest 25 load first; older pages remain available below.</p>
    {active.length > 0 && <p role="status">{active.length} active or queued run{active.length === 1 ? "" : "s"} in loaded history.</p>}
    {error && <p role="alert">{loaded ? "History refresh failed; the visible rows are retained. " : "Run history could not load. "}{error} <button type="button" onClick={() => { const retry = failed.current; if (retry) void load(retry.cursor, retry.reset); }}>Retry</button></p>}
    {!loaded && busy && <p role="status">Loading saved runs…</p>}
    {loaded && items.length === 0 && <p className="empty">No runs have been saved yet. Launch an evaluation to start a history.</p>}
    {items.length > 0 && <ol className="run-history-list">{items.map(item => <li key={item.id}>
      <RouteLink href={`/runs/${item.id}`} navigate={navigate} className="run-history-link">
        <strong>{item.target.name || item.target.id}</strong><span>{item.mode} · {item.status}{item.outcome ? ` / ${item.outcome}` : ""}{item.stopRequested ? " · stop requested" : ""}</span>
      </RouteLink>
      <p>{item.mode === "selected" ? item.caseSnapshot?.title || "Saved selected case" : `${item.adaptiveCategories?.length ?? 0} planned categor${item.adaptiveCategories?.length === 1 ? "y" : "ies"}`} · Target version {item.target.version || "awaiting handshake"}</p>
      <small>Created {when(item.createdAt)}{item.finishedAt ? ` · Finished ${when(item.finishedAt)}` : ""}</small>
    </li>)}</ol>}
    {cursor && <button type="button" disabled={busy} onClick={() => void load(cursor)}>{busy ? "Loading…" : "Load older runs"}</button>}
  </section>;
}
