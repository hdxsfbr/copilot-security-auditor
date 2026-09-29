import React, { useEffect, useId, useState } from "react";
import { Field } from "./Field.js";
import { GapChip, SafeRate } from "./CoverageTable.js";
import { categoryLabel, fetchCoverage, fmtTime, filtersQuery, observedText, reportFilters, scopeKey, scopeLabel, versionLabel, windowText, type CoverageReport, type CoverageRow, type CoverageScope } from "./model.js";

type Side = { title: string; detail: string; scope: CoverageScope | null };
type Category = Extract<CoverageRow, { level: "category" }>;
const categoryRow = (scope: CoverageScope | null, name: string) => scope?.rows.find((row): row is Category => row.level === "category" && row.category === name);
const change = (a?: Category, b?: Category) => a?.counts.safeRate.rate == null || b?.counts.safeRate.rate == null ? "n/a" : `${b.counts.safeRate.rate >= a.counts.safeRate.rate ? "+" : "−"}${Math.abs(Math.round((b.counts.safeRate.rate - a.counts.safeRate.rate) * 100))} pp`;

function SideCells({ row }: { row?: Category }) {
  return row ? <><td><SafeRate rate={row.counts.safeRate} /></td><td><GapChip gap={row.gap} /></td><td className="num">{row.counts.cases.untested} of {row.counts.cases.catalog}</td></>
    : <td colSpan={3}><span className="cov-meta">No data for this side</span></td>;
}

function CompareTable({ a, b }: { a: Side; b: Side }) {
  const names = [...new Set([a.scope, b.scope].flatMap(scope => scope?.rows ?? []).filter(row => row.level === "category").map(row => row.category))];
  const head = (side: Side, tag: string) => <th colSpan={3} scope="colgroup">{tag}: {side.title}<span className="cov-meta">{side.detail}</span></th>;
  const totals = (scope: CoverageScope | null) => scope ? <><td><SafeRate rate={scope.totals.safeRate} /></td><td>—</td><td className="num">{scope.totals.cases.untested} of {scope.totals.cases.catalog}</td></> : <td colSpan={3}><span className="cov-meta">No data for this side</span></td>;
  return <div className="cov-scroll" role="region" aria-label="Comparison table" tabIndex={0}><table className="cov-table cov-compare-table">
    <caption>Per category: safe rate as numerator/denominator with excluded count, gap, and untested published cases. Each side is one target and version; nothing is pooled.</caption>
    <thead><tr><th rowSpan={2} scope="col" className="cov-first">Category</th>{head(a, "A")}{head(b, "B")}<th rowSpan={2} scope="col">Safe-rate change (B minus A)</th></tr>
      <tr>{["Safe rate n/d", "Gap", "Untested cases", "Safe rate n/d", "Gap", "Untested cases"].map((label, index) => <th key={index} scope="col">{label}</th>)}</tr></thead>
    <tbody>{names.map(name => { const ra = categoryRow(a.scope, name), rb = categoryRow(b.scope, name);
      return <tr key={name}><th scope="row" className="cov-first">{categoryLabel(name)}</th><SideCells row={ra} /><SideCells row={rb} /><td>{change(ra, rb)}</td></tr>; })}</tbody>
    <tfoot><tr><th scope="row" className="cov-first">Scope total</th>{totals(a.scope)}{totals(b.scope)}<td>—</td></tr></tfoot>
  </table></div>;
}

// Comparisons only ever pair scopes of one target: two recorded versions in the same window, or one scope against the
// preceding window of equal length. Different targets are disabled, never pooled.
export function CoverageCompare({ report }: { report: CoverageReport }) {
  const id = useId(), { scopes } = report;
  const [kind, setKind] = useState<"versions" | "window">("versions");
  const [first, setFirst] = useState(""), [second, setSecond] = useState(""), [single, setSingle] = useState("");
  const [earlier, setEarlier] = useState<{ report: CoverageReport | null; error: string; loading: boolean }>({ report: null, error: "", loading: false });
  const byKey = (key: string) => scopes.find(scope => scopeKey(scope) === key);
  const a = byKey(first), b = byKey(second), only = byKey(single);
  const filters = reportFilters(report), since = filters.since;
  const length = since ? Date.parse(filters.until || report.generatedAt) - Date.parse(since) : 0;
  const previous = since && length > 0 ? { ...filters, since: new Date(Date.parse(since) - length).toISOString(), until: since } : null;
  const previousQuery = previous ? filtersQuery(previous) : "";
  const canCompareWindows = previous !== null;
  useEffect(() => {
    if (kind !== "window" || !previousQuery) return;
    let current = true;
    setEarlier({ report: null, error: "", loading: true });
    fetchCoverage(previousQuery).then(next => current && setEarlier({ report: next, error: "", loading: false }), cause => current && setEarlier({ report: null, error: cause instanceof Error ? cause.message : "Earlier window unavailable", loading: false }));
    return () => { current = false; };
  }, [kind, previousQuery, report.generatedAt]);
  const pickFirst = (key: string) => { setFirst(key); const next = byKey(key); if (next && b && (b.target.id !== next.target.id || key === second)) setSecond(""); };
  const scopeOption = (scope: CoverageScope, anchor?: CoverageScope) => { const other = !!anchor && anchor.target.id !== scope.target.id;
    return <option key={scopeKey(scope)} value={scopeKey(scope)} disabled={other || scope === anchor}>{scopeLabel(scope)}{scope.observed.lastAt ? ` · last ${fmtTime(scope.observed.lastAt)}` : " · no executions"}{other ? " (different target, disabled)" : scope === anchor ? " (already chosen)" : ""}</option>; };
  const earlierScope = only && earlier.report ? earlier.report.scopes.find(scope => scopeKey(scope) === scopeKey(only)) ?? null : null;
  return <section className="panel cov-compare" aria-labelledby={`${id}-h`}>
    <h2 id={`${id}-h`}>Compare scopes</h2>
    <p className="hint">Compare only like with like: two versions of one target in this window, or one target version against the window just before it. Scopes of different targets can never be compared.</p>
    <div className="cov-pick">
      <Field label="Comparison">{id => <select id={id} value={kind} onChange={event => setKind(event.target.value as "versions" | "window")}>
        <option value="versions">Two versions of one target</option><option value="window">One scope, earlier window</option></select>}</Field>
      {kind === "versions" ? <>
        <Field label="Scope A">{id => <select id={id} value={first} onChange={event => pickFirst(event.target.value)}><option value="">Choose a scope</option>{scopes.map(scope => scopeOption(scope))}</select>}</Field>
        <Field label="Scope B">{id => <select id={id} value={second} onChange={event => setSecond(event.target.value)}><option value="">Choose a scope</option>{scopes.map(scope => scopeOption(scope, a))}</select>}</Field>
      </> : <Field label="Scope">{id => <select id={id} value={single} onChange={event => setSingle(event.target.value)}><option value="">Choose a scope</option>{scopes.map(scope => scopeOption(scope))}</select>}</Field>}
    </div>
    {kind === "versions" && scopes.length < 2 && <p className="cov-note">This view has only one scope. Clear the version filter (with a target selected) to see its other versions.</p>}
    {kind === "versions" && scopes.length >= 2 && new Set(scopes.map(scope => scope.target.id)).size === scopes.length && <p className="cov-note">Every scope here belongs to a different target, so nothing can be compared. Select one target to compare its versions.</p>}
    {kind === "versions" && a && <p className="cov-note">Options for other targets are disabled because executions from different targets are never compared.</p>}
    {kind === "versions" && a && b && <>
      <p className="cov-compare-note">Comparing <strong>{versionLabel(a.targetVersion)}</strong> with <strong>{versionLabel(b.targetVersion)}</strong> of {a.target.name} over {windowText(filters)}.</p>
      <CompareTable a={{ title: versionLabel(a.targetVersion), detail: observedText(a), scope: a }} b={{ title: versionLabel(b.targetVersion), detail: observedText(b), scope: b }} /></>}
    {kind === "window" && !canCompareWindows && <p className="cov-note">Set a start time (for example Last 7 days) to compare a scope with the window before it.</p>}
    {kind === "window" && canCompareWindows && !only && <p className="cov-note">Choose a scope to compare {windowText(filters)} with the earlier window of equal length.</p>}
    {kind === "window" && only && previous && <>
      {earlier.loading && <p role="status">Loading the earlier window…</p>}
      {earlier.error && <p className="alert" role="alert">The earlier window could not be loaded: {earlier.error}</p>}
      {earlier.report && <>
        <p className="cov-compare-note">Comparing {scopeLabel(only)} in the earlier window <strong>{windowText(previous)}</strong> with the selected window <strong>{windowText(filters)}</strong>. Both use {versionLabel(only.targetVersion)}.</p>
        {!earlierScope && <p className="cov-note">This target version has no executions in the earlier window; that is a gap, not a zero rate.</p>}
        <CompareTable a={{ title: "Earlier window", detail: windowText(previous), scope: earlierScope }} b={{ title: "Selected window", detail: windowText(filters), scope: only }} /></>}
    </>}
  </section>;
}
