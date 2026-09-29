import React, { useEffect, useState } from "react";
import { isRecordArray, requestJson } from "../api/client.js";
import { isCaseRecord, type CaseRecord } from "../components/cases/model.js";
import { RouteLink } from "../components/router.js";
import { CaseEditor } from "./CaseEditor.js";
import { useWorkspace } from "./context.js";
import "../components/cases/style.css";

export function CasesPage({ selectedId, active }: { selectedId?: string; active: boolean }) {
  const { cases, refresh, navigate } = useWorkspace();
  const [drafts, setDrafts] = useState<CaseRecord[]>([]);
  const [archived, setArchived] = useState<CaseRecord[]>([]);
  const [draftError, setDraftError] = useState("");
  const [archiveError, setArchiveError] = useState("");
  const loadDrafts = async () => {
    try { setDrafts(await requestJson("/cases/drafts", isRecordArray(isCaseRecord))); setDraftError(""); }
    catch (cause) { setDraftError(cause instanceof Error ? cause.message : "Drafts unavailable"); }
  };
  const loadArchived = async () => {
    try { setArchived(await requestJson("/cases/archived", isRecordArray(isCaseRecord))); setArchiveError(""); }
    catch (cause) { setArchiveError(cause instanceof Error ? cause.message : "Archived cases unavailable"); }
  };
  useEffect(() => { void loadDrafts(); void loadArchived(); }, []);
  const onMutate = async () => { await Promise.all([loadDrafts(), loadArchived(), refresh()]); };
  return <div className="case-workspace">
    <aside className="panel case-catalog" aria-label="Case catalog">
      <div className="eyebrow">REPEATABLE TEST DEFINITIONS</div><h2>Case library</h2>
      <p className="hint">Only published versions can be selected for a run. Drafts and archived versions stay in their family history.</p>
      <RouteLink className="task-link" href="/cases" navigate={navigate}>Create new draft</RouteLink>
      {draftError && <p role="alert">Drafts could not refresh: {draftError} <button type="button" onClick={() => void loadDrafts()}>Retry drafts</button></p>}
      {archiveError && <p role="alert">Archived cases could not refresh: {archiveError} <button type="button" onClick={() => void loadArchived()}>Retry archived cases</button></p>}
      <h3>Drafts</h3>{drafts.length ? <ul>{drafts.map(draft => <li key={draft.id}><RouteLink href={`/cases/${draft.id}`} navigate={navigate}>{draft.title}</RouteLink><small>Version {draft.version} · not runnable</small></li>)}</ul> : <p className="hint">No saved drafts.</p>}
      <h3>Published</h3>{cases.length ? <ul>{cases.map(item => <li key={item.id}><RouteLink href={`/cases/${item.id}`} navigate={navigate}>{item.title}</RouteLink><small>{item.category?.replaceAll("_", " ") ?? "category unknown"}</small></li>)}</ul> : <p className="hint">No published cases.</p>}
      <h3>Archived</h3>{archived.length ? <ul>{archived.map(item => <li key={item.id}><RouteLink href={`/cases/${item.id}`} navigate={navigate}>{item.title}</RouteLink><small>Version {item.version} · historical only</small></li>)}</ul> : <p className="hint">No archived versions.</p>}
    </aside>
    <CaseEditor id={selectedId} active={active} onMutate={onMutate} />
  </div>;
}
