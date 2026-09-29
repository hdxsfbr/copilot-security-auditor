import React, { useState } from "react";
import { ApiResponseError, requestJson } from "../api/client.js";
import { IdentityList } from "../components/regressions/IdentityList.js";
import { SuitePanel } from "../components/regressions/SuitePanel.js";
import { TriggerPanel } from "../components/regressions/TriggerPanel.js";
import { isIdentityList, isSuiteDetail, isSuiteList, isTriggers, newSuiteForm, suiteSettings } from "../components/regressions/model.js";
import { useLoaded } from "../components/regressions/useLoaded.js";
import { RouteLink } from "../components/router.js";
import "../components/regressions/style.css";
import { useWorkspace } from "./context.js";

const activeSuites = (list: { items: { state: string }[] } | null) => !!list?.items.some(suite => suite.state === "active");

export function RegressionsPage({ active }: { active: boolean }) {
  const { regressions, findings, selectRegression, targets, model, ollamaUrl, navigate, refresh } = useWorkspace();
  const [filter, setFilter] = useState({ targetId: "", version: "" });
  const query = filter.targetId ? `?targetId=${filter.targetId}${filter.version.trim() ? `&targetVersion=${encodeURIComponent(filter.version.trim())}` : ""}` : "";
  const identities = useLoaded(`/regression-identities${query}`, isIdentityList, active);
  const suites = useLoaded("/regression-suites?limit=25", isSuiteList, active, activeSuites);
  const triggers = useLoaded("/regression-triggers", isTriggers, active);
  const [validate, setValidate] = useState({ targetId: "", version: "" }), [busy, setBusy] = useState(false), [problem, setProblem] = useState<{ text: string; runId?: string } | null>(null);
  const target = targets.find(item => item.id === validate.targetId);
  // The operator-triggered action: one bounded suite of every confirmed identity seen on the target, with the composer's local Judge defaults.
  const validateVersion = async () => {
    setBusy(true); setProblem(null);
    const version = validate.version.trim();
    try {
      await requestJson("/regression-suites", isSuiteDetail, { method: "POST", body: JSON.stringify({ targetId: validate.targetId, selection: { mode: "all_confirmed" }, ...suiteSettings(newSuiteForm(model, ollamaUrl)), ...(version ? { expectedVersion: version } : {}) }) });
      void suites.reload(); void identities.reload(); void refresh();
    } catch (cause) { setProblem({ text: cause instanceof Error ? cause.message : "Suite could not start", runId: cause instanceof ApiResponseError ? cause.activeRunId : undefined }); }
    finally { setBusy(false); }
  };
  return <>
    <section className="panel" aria-labelledby="regressions-heading">
      <div className="eyebrow">CONFIRMED ATTACKS</div>
      <h2 id="regressions-heading">Regression state</h2>
      <p className="hint">Each state is derived from recorded replays per target and observed version. Fixed needs a finished safe replay on a later verified version after a violation; blocked, incomplete, inconclusive and missing results are Unknown, never Fixed.</p>
      <div className="pair regression-filter">
        <label>Target<select value={filter.targetId} onChange={event => setFilter({ targetId: event.target.value, version: "" })}><option value="">All targets</option>{targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>Version (exact, optional)<input value={filter.version} disabled={!filter.targetId} maxLength={200} onChange={event => setFilter(value => ({ ...value, version: event.target.value }))}/></label>
      </div>
      {identities.error && <p role="alert" className="alert">Regression identities unavailable: {identities.error} <button type="button" onClick={() => void identities.reload()}>Retry</button></p>}
      {identities.data ? <IdentityList list={identities.data} navigate={navigate}/> : !identities.error && <p role="status">Loading regression identities…</p>}
    </section>
    <section className="panel" aria-labelledby="suites-heading">
      <div className="eyebrow">BOUNDED SUITES</div>
      <h2 id="suites-heading">Regression suites</h2>
      <p className="hint">A suite replays identities against one target, one at a time, through the normal reservation. It never deploys or patches the target and never re-runs an item that ended blocked or incomplete. Configure roles and bounds in <RouteLink href="/runs/new" navigate={navigate}>the composer's suite mode</RouteLink>.</p>
      <form className="validate-version" onSubmit={event => { event.preventDefault(); void validateVersion(); }}>
        <h3>Validate a new version</h3>
        <div className="pair">
          <label>Target<select required value={validate.targetId} onChange={event => setValidate(value => ({ ...value, targetId: event.target.value }))}><option value="">Select a saved target</option>{targets.map(item => <option key={item.id} value={item.id}>{item.name}{item.activeRunId ? " (reserved)" : ""}</option>)}</select></label>
          <label>Version being validated (label only, optional)<input value={validate.version} maxLength={200} onChange={event => setValidate(value => ({ ...value, version: event.target.value }))}/></label>
        </div>
        <p className="hint">Runs every confirmed identity seen on the target (up to 25, 60 minutes) with the local Judge {model || "(no default model)"}. Each result records the version its own run observed.</p>
        {target?.activeRunId && <p role="status" className="composer-warning">This target is reserved by an active run; a suite cannot start until it finishes.</p>}
        <button className="primary" type="submit" disabled={busy || !validate.targetId || !model || !ollamaUrl}>{busy ? "Starting…" : "Validate new version"}</button>
        {problem && <p role="alert" className="alert">{problem.text}{problem.runId && <> <RouteLink href={`/runs/${problem.runId}`} navigate={navigate}>Inspect active run {problem.runId.slice(0, 8)}</RouteLink></>}</p>}
      </form>
      {suites.error && <p role="alert" className="alert">Suites unavailable: {suites.error} <button type="button" onClick={() => void suites.reload()}>Retry</button></p>}
      {suites.data ? <SuitePanel list={suites.data} reload={() => { void suites.reload(); void identities.reload(); void refresh(); }} navigate={navigate}/> : !suites.error && <p role="status">Loading suites…</p>}
    </section>
    <section className="panel" aria-labelledby="triggers-heading">
      <div className="eyebrow">OPT-IN</div>
      <h2 id="triggers-heading">Version-change trigger</h2>
      {triggers.error && <p role="alert" className="alert">Trigger settings unavailable: {triggers.error} <button type="button" onClick={() => void triggers.reload()}>Retry</button></p>}
      {triggers.data ? <TriggerPanel triggers={triggers.data} model={model} ollamaUrl={ollamaUrl} reload={() => void triggers.reload()}/> : !triggers.error && <p role="status">Loading trigger settings…</p>}
    </section>
    <section className="panel" aria-labelledby="definitions-heading">
      <div className="eyebrow">CONFIRMED DEFINITIONS</div>
      <h2 id="definitions-heading">Select a definition for one replay</h2>
      {regressions.length ? regressions.map(regression => <article className="review-item" key={regression.id}>
        <strong>{regression.definition.title}</strong>
        <p>Baseline {regression.version ?? "unknown"} · original run {regression.sourceRunId.slice(0, 8)}</p>
        <p>{regression.replays.length ? regression.replays.map(replay => `${replay.version ?? "unknown"}: ${replay.outcome}`).join(" · ") : "No replay on this target yet"}</p>
        {findings.some(finding => finding.runId === regression.sourceRunId) &&
          <button type="button" onClick={() => void selectRegression(regression.id, regression.sourceRunId)}>Select for replay</button>}
      </article>) : <p className="hint">No confirmed regression definitions yet.</p>}
    </section>
  </>;
}
