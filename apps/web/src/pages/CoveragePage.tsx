import React, { useCallback, useEffect, useRef, useState } from "react";
import { Field } from "../components/coverage/Field.js";
import { CoverageCompare } from "../components/coverage/CoverageCompare.js";
import { ScopeTable } from "../components/coverage/CoverageTable.js";
import { CoverageError, emptyFilters, fetchCoverage, filtersQuery, fmtTime, modeLabel, parseFilters, reportFilters, versionLabel, windowInvalid, windowText, type CoverageReport, type Filters, type Mode } from "../components/coverage/model.js";
import "../components/coverage/style.css";
import { useWorkspace } from "./context.js";

type Load = { report: CoverageReport | null; error: CoverageError | null; loading: boolean };
const ROUTE = /^\/coverage\/*$/;
const hours = (count: number) => new Date(Date.now() - count * 3_600_000).toISOString();
const inputValue = (iso: string) => iso.slice(0, 16);
const fromInput = (value: string) => value ? `${value}:00.000Z` : "";
const list = (names: string[]) => names.map(name => name.replaceAll("_", " ")).join(" + ");

export function CoveragePage() {
  const { targets } = useWorkspace();
  const [filters, setFilters] = useState(() => parseFilters(window.location.search));
  const [load, setLoad] = useState<Load>({ report: null, error: null, loading: true });
  const [versions, setVersions] = useState<{ targetId: string; observed: (string | null)[] } | null>(null);
  const [showCases, setShowCases] = useState(true), [tick, setTick] = useState(0);
  const sequence = useRef(0);
  const query = filtersQuery(filters), invalid = windowInvalid(filters);

  // A filter change is a history entry, so back/forward and a copied link reproduce the view.
  const apply = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch }, search = filtersQuery(next);
    setFilters(next);
    if (search !== window.location.search) window.history.pushState(null, "", `/coverage${search}`);
  };
  useEffect(() => {
    const onPop = () => { if (ROUTE.test(window.location.pathname)) setFilters(parseFilters(window.location.search)); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const reload = useCallback(async () => {
    if (invalid) { setLoad(state => ({ ...state, loading: false })); return; }
    const request = ++sequence.current;
    setLoad(state => ({ ...state, loading: true }));
    try {
      const report = await fetchCoverage(query);
      if (sequence.current === request) setLoad({ report, error: null, loading: false });
    } catch (cause) {
      const error = cause instanceof CoverageError ? cause : new CoverageError("Coverage could not be loaded.", null);
      // Last good data survives a transient failure; a missing target invalidates the request itself, so nothing stale is shown for it.
      if (sequence.current === request) setLoad(state => ({ report: error.status === 404 ? null : state.report, error, loading: false }));
    }
  }, [query, invalid, tick]);
  useEffect(() => { void reload(); return () => { sequence.current++; }; }, [reload]);

  // Version choices come from a target-only request so they do not shrink as the other filters narrow.
  useEffect(() => {
    if (!filters.targetId) { setVersions(null); return; }
    let current = true;
    const targetId = filters.targetId;
    fetchCoverage(filtersQuery({ ...emptyFilters, targetId })).then(
      report => { if (current) setVersions({ targetId, observed: report.scopes.map(scope => scope.targetVersion) }); },
      () => { if (current) setVersions({ targetId, observed: [] }); });
    return () => { current = false; };
  }, [filters.targetId, tick]);

  const { report, error, loading } = load;
  const targetName = targets.find(target => target.id === filters.targetId)?.name ?? report?.scopes.find(scope => scope.target.id === filters.targetId)?.target.name ?? (filters.targetId ? `Unknown target ${filters.targetId.slice(0, 8)}` : "All targets");
  const versionChoices = filters.targetId && versions?.targetId === filters.targetId ? [...new Set(versions.observed.map(version => version ?? "unknown"))] : [];
  if (filters.targetVersion && !versionChoices.includes(filters.targetVersion) && filters.targetId) versionChoices.push(filters.targetVersion);
  if (filters.targetId && !versionChoices.includes("unknown")) versionChoices.push("unknown");
  const reportMatches = !!report && filtersQuery(reportFilters(report)) === query;
  const version = filters.targetVersion ? (filters.targetVersion === "unknown" ? "Version unknown" : filters.targetVersion) : "All versions";

  return <div className="coverage-page">
    <section className="panel cov-filters" aria-labelledby="coverage-filters-heading">
      <div className="eyebrow">SCOPE</div><h2 id="coverage-filters-heading">Choose what to examine</h2>
      <div className="cov-filter-grid">
        <Field label="Target">{id => <select id={id} value={filters.targetId} onChange={event => apply({ targetId: event.target.value, targetVersion: "" })}>
          <option value="">All targets (shown separately)</option>
          {targets.map(target => <option key={target.id} value={target.id}>{target.name}</option>)}
          {filters.targetId && !targets.some(target => target.id === filters.targetId) && <option value={filters.targetId}>{targetName}</option>}</select>}</Field>
        <Field label="Target version">{id => <select id={id} value={filters.targetVersion} disabled={!filters.targetId} onChange={event => apply({ targetVersion: event.target.value })}>
          <option value="">{filters.targetId ? "All versions" : "Choose a target first"}</option>
          {versionChoices.map(choice => <option key={choice} value={choice}>{choice === "unknown" ? "Version unknown (never established)" : choice}</option>)}</select>}</Field>
        <Field label="Run mode">{id => <select id={id} value={filters.mode} onChange={event => apply({ mode: event.target.value as Mode })}>
          {(Object.keys(modeLabel) as Mode[]).map(mode => <option key={mode} value={mode}>{modeLabel[mode]}</option>)}</select>}</Field>
      </div>
      <fieldset className="cov-window"><legend>Execution start window (UTC)</legend>
        <div className="cov-presets">
          <button type="button" onClick={() => apply({ since: "", until: "" })}>All time</button>
          <button type="button" onClick={() => apply({ since: hours(24), until: "" })}>Last 24 hours</button>
          <button type="button" onClick={() => apply({ since: hours(168), until: "" })}>Last 7 days</button></div>
        <div className="cov-filter-grid">
          <Field label="Since (inclusive)">{id => <input id={id} type="datetime-local" value={filters.since ? inputValue(filters.since) : ""} onChange={event => apply({ since: fromInput(event.target.value) })} />}</Field>
          <Field label="Until (exclusive)">{id => <input id={id} type="datetime-local" value={filters.until ? inputValue(filters.until) : ""} onChange={event => apply({ until: fromInput(event.target.value) })} />}</Field></div>
        {invalid && <p className="alert" role="alert">Since must be earlier than until. The report was not refreshed.</p>}
      </fieldset>
      <div className="cov-actions"><button type="button" onClick={() => setTick(value => value + 1)}>Refresh</button>
        <button type="button" onClick={() => apply(emptyFilters)}>Clear filters</button></div>
    </section>

    <ul className="cov-active" aria-label="Active filters">
      <li>Target: <strong>{targetName}</strong></li><li>Version: <strong>{version}</strong></li>
      <li>Window: <strong>{windowText(filters)}</strong></li><li>Mode: <strong>{modeLabel[filters.mode]}</strong></li>
    </ul>
    <p className="hint cov-scoped-note">Each table below is one target at one recorded version. Counts are never summed across tables{filters.targetId ? "" : ", and this view is not any single target's coverage"}.</p>

    {loading && !report && !error && <p role="status">Loading coverage…</p>}
    {error && <div className="alert" role="alert">{error.message} <button type="button" onClick={() => setTick(value => value + 1)}>Retry</button>
      {error.status === 404 && filters.targetId && <button type="button" onClick={() => apply({ targetId: "", targetVersion: "" })}>Clear target filter</button>}</div>}
    {report && !reportMatches && !loading && error && <p className="cov-note">Showing the last loaded report ({fmtTime(report.generatedAt)} UTC) for {targets.find(target => target.id === report.filters.targetId)?.name ?? (report.filters.targetId ? "another target" : "All targets")}, {report.filters.targetVersion ? versionLabel(report.filters.targetVersion) : "all versions"}, {windowText(reportFilters(report))}. It does not match the filters above.</p>}
    {loading && report && <p role="status" className="cov-note">Updating for the selected filters…</p>}

    {report && <div className={loading ? "cov-results updating" : "cov-results"} aria-busy={loading}>
      <div className="cov-toolbar"><span>Generated {fmtTime(report.generatedAt)} UTC · wide tables scroll sideways inside their frame</span>
        <label className="cov-check"><input type="checkbox" checked={showCases} onChange={event => setShowCases(event.target.checked)} /> Show individual cases</label></div>
      <p className="hint cov-policy">Safe rate = {list(report.safeRatePolicy.numerator)} ÷ ({list(report.safeRatePolicy.denominator)}). Excluded from the rate and never counted as safe: {list(report.safeRatePolicy.excluded)}. Outcomes are immutable execution results; review columns show the current finding disposition and never change them.</p>
      {report.scopes.length === 0
        ? <section className="panel" aria-label="No matching scopes"><p className="cov-empty">No executions recorded for {reportMatches ? targetName : "these filters"} {report.filters.since || report.filters.until ? `in ${windowText(reportFilters(report))}` : "yet"}, so there is no target version scope to show.
          {filters.targetId ? " Choose “Version unknown” to list its published cases as untested." : " Choose a target, then a version, to list its published cases as untested."}</p></section>
        : report.scopes.map(scope => <ScopeTable key={JSON.stringify([scope.target.id, scope.targetVersion])} scope={scope} showCases={showCases} />)}
      <CoverageCompare report={report} />
    </div>}
  </div>;
}
