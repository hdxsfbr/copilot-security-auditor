import React, { useId } from "react";
import { categoryLabel, gapInfo, observedText, scopeLabel, versionLabel, type CoverageCounts, type CoverageRow, type CoverageScope } from "./model.js";

type Column = { key: string; label: string; value: (counts: CoverageCounts) => number };
const execution: Column[] = [
  { key: "attempted", label: "Attempted", value: c => c.attempted }, { key: "executed", label: "Executed", value: c => c.executed },
  { key: "assessed", label: "Assessed", value: c => c.assessed }, { key: "notAttempted", label: "Not attempted", value: c => c.notAttempted }, { key: "inFlight", label: "In flight", value: c => c.inFlight }];
const outcomes: Column[] = [
  { key: "safe", label: "Safe", value: c => c.outcomes.safe }, { key: "pending_review", label: "Pending review", value: c => c.outcomes.pending_review },
  { key: "auto_confirm", label: "Auto-confirm", value: c => c.outcomes.auto_confirm }, { key: "inconclusive", label: "Inconclusive", value: c => c.outcomes.inconclusive },
  { key: "blocked", label: "Blocked", value: c => c.outcomes.blocked }, { key: "incomplete", label: "Incomplete", value: c => c.outcomes.incomplete }];
const review: Column[] = [
  { key: "candidates", label: "Candidates", value: c => c.disposition.candidates }, { key: "awaitingReview", label: "Awaiting review", value: c => c.disposition.awaitingReview },
  { key: "confirmed", label: "Confirmed", value: c => c.disposition.confirmed }, { key: "rejected", label: "Rejected", value: c => c.disposition.rejected },
  { key: "reviewed", label: "Reviewed by operator", value: c => c.reviewed }];

export function GapChip({ gap }: { gap: CoverageRow["gap"] }) {
  if (!gap) return <span className="cov-gap cov-gap-none" title="A determinate result exists">Has result</span>;
  const info = gapInfo[gap];
  return <span className={`cov-gap cov-gap-${gap}`} title={info.hint}><span aria-hidden="true">{info.glyph} </span>{info.label}</span>;
}

// numerator/denominator with excluded beside it; a null rate is "n/a", never 0%.
export function SafeRate({ rate }: { rate: CoverageCounts["safeRate"] }) {
  return <span className="cov-rate"><strong>{rate.numerator}/{rate.denominator}</strong>{rate.rate === null ? <em> n/a</em> : <span> ({Math.round(rate.rate * 100)}%)</span>}<small>{rate.excluded} excluded</small></span>;
}

function Cells({ counts }: { counts: CoverageCounts }) {
  const cell = (column: Column) => { const value = column.value(counts); return <td key={column.key} data-col={column.key} className={value ? "num" : "num zero"}>{value}</td>; };
  return <><td data-col="safeRate"><SafeRate rate={counts.safeRate} /></td>{outcomes.map(cell)}{review.map(cell)}{execution.map(cell)}</>;
}

function RowLabel({ row }: { row: CoverageRow }) {
  if (row.level === "case") return <><span className="sr-only">Case: </span>{row.case.title}<span className="cov-meta"> v{row.case.version}{row.case.catalogState === "archived" ? " · archived version" : ""}{row.case.metadataStatus === "unknown_legacy" ? " · legacy metadata" : ""}</span></>;
  const cases = <span className="cov-meta">{row.counts.cases.catalog} published case{row.counts.cases.catalog === 1 ? "" : "s"} · {row.counts.cases.untested} untested</span>;
  if (row.level === "subcategory") return <><span className="sr-only">Subcategory: </span>{row.subcategory ?? "(no subcategory)"} {cases}</>;
  return <><span className="sr-only">Category: </span><strong>{categoryLabel(row.category)}</strong> {cases}</>;
}
const rowKey = (row: CoverageRow) => row.level === "case" ? `k:${row.case.id}` : row.level === "subcategory" ? `s:${row.category}:${row.subcategory ?? ""}` : `c:${row.category}`;

export function ScopeTable({ scope, showCases }: { scope: CoverageScope; showCases: boolean }) {
  const id = useId(), { totals } = scope;
  const idle = totals.attempted === 0 && totals.inFlight === 0 && totals.notAttempted === 0;
  const rows = scope.rows.filter(row => showCases || row.level !== "case");
  return <section className="panel cov-scope" aria-labelledby={`${id}-h`}>
    <div className="cov-scope-head">
      <h3 id={`${id}-h`}>{scope.target.name} <span className="cov-version">· {versionLabel(scope.targetVersion)}</span></h3>
      <p className="cov-observed">{observedText(scope)}</p>
    </div>
    <dl className="cov-totals" aria-label={`Totals for ${scopeLabel(scope)} only`}>
      <div><dt>Attempted</dt><dd>{totals.attempted}</dd></div><div><dt>Executed</dt><dd>{totals.executed}</dd></div>
      <div><dt>Not attempted</dt><dd>{totals.notAttempted}</dd></div><div><dt>Safe rate</dt><dd><SafeRate rate={totals.safeRate} /></dd></div>
      <div><dt>Untested cases</dt><dd>{totals.cases.untested} of {totals.cases.catalog} published</dd></div>
    </dl>
    {idle && <p className="cov-empty">No executions in this scope — {totals.cases.untested} published case{totals.cases.untested === 1 ? "" : "s"} untested.</p>}
    <div className="cov-scroll" role="region" aria-label={`Coverage table for ${scopeLabel(scope)}`} tabIndex={0}>
      <table className="cov-table">
        <caption>{scopeLabel(scope)} — outcome and review columns are separate; untested, blocked and inconclusive are never combined.</caption>
        <thead>
          <tr><th rowSpan={2} scope="col" className="cov-first">Category / subcategory / case</th><th rowSpan={2} scope="col">Gap</th><th rowSpan={2} scope="col">Safe rate n/d</th>
            <th colSpan={outcomes.length} scope="colgroup">Outcome (immutable)</th><th colSpan={review.length} scope="colgroup">Review (disposition)</th>
            <th colSpan={execution.length} scope="colgroup">Execution</th></tr>
          <tr>{[...outcomes, ...review, ...execution].map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr>
        </thead>
        <tbody>{rows.map(row => <tr key={rowKey(row)} className={`lvl-${row.level}`}><th scope="row" className="cov-first"><RowLabel row={row} /></th><td><GapChip gap={row.gap} /></td><Cells counts={row.counts} /></tr>)}</tbody>
        <tfoot><tr><th scope="row" className="cov-first">Scope total (this target and version only)</th><td>—</td><Cells counts={totals} /></tr></tfoot>
      </table>
    </div>
  </section>;
}
