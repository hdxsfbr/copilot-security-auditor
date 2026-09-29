import { isRecord } from "../../api/client.js";
import type { CoverageCounts, CoverageReport, CoverageRow, CoverageScope } from "../../../../../packages/contracts/src/coverage.js";

export type { CoverageCounts, CoverageReport, CoverageRow, CoverageScope };
export type Mode = "all" | "selected" | "adaptive";
export type Gap = NonNullable<CoverageRow["gap"]>;
// The URL query uses the API's own parameter names, so a copied link and the request describe the same view.
export type Filters = { targetId: string; targetVersion: string; since: string; until: string; mode: Mode };
export const emptyFilters: Filters = { targetId: "", targetVersion: "", since: "", until: "", mode: "all" };

const nat = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown): value is string => typeof value === "string";
const natsIn = (value: unknown, keys: string[]) => isRecord(value) && keys.every(key => nat(value[key]));
const gaps = ["untested", "in_flight", "blocked", "incomplete", "inconclusive"];
const isCounts = (value: unknown): value is CoverageCounts => isRecord(value)
  && natsIn(value, ["attempted", "executed", "assessed", "reviewed", "notAttempted", "inFlight"])
  && natsIn(value.outcomes, ["safe", "pending_review", "auto_confirm", "inconclusive", "blocked", "incomplete"])
  && natsIn(value.disposition, ["candidates", "awaitingReview", "confirmed", "rejected"])
  && natsIn(value.safeRate, ["numerator", "denominator", "excluded"]) && isRecord(value.safeRate)
  && (value.safeRate.rate === null || (typeof value.safeRate.rate === "number" && value.safeRate.rate >= 0 && value.safeRate.rate <= 1))
  && natsIn(value.cases, ["catalog", "attempted", "executed", "untested"]);
const isRow = (value: unknown): value is CoverageRow => isRecord(value) && text(value.category) && isCounts(value.counts) && (value.gap === null || gaps.includes(String(value.gap)))
  && (value.level === "category" || ((value.level === "subcategory" || value.level === "case") && (value.subcategory === null || text(value.subcategory))))
  && (value.level !== "case" || (isRecord(value.case) && text(value.case.id) && text(value.case.title) && nat(value.case.version)
    && (value.case.catalogState === "published" || value.case.catalogState === "archived") && (value.case.metadataStatus === "complete" || value.case.metadataStatus === "unknown_legacy")));
const isTime = (value: unknown) => value === null || (text(value) && !Number.isNaN(Date.parse(value)));
const strings = (value: unknown) => Array.isArray(value) && value.every(text);
const isScope = (value: unknown): value is CoverageScope => isRecord(value) && isRecord(value.target) && text(value.target.id) && text(value.target.name)
  && (value.targetVersion === null || text(value.targetVersion)) && isRecord(value.observed) && isTime(value.observed.firstAt) && isTime(value.observed.lastAt)
  && isCounts(value.totals) && Array.isArray(value.rows) && value.rows.every(isRow);
export const isCoverageReport = (value: unknown): value is CoverageReport => isRecord(value) && value.v === 1 && text(value.generatedAt) && isRecord(value.filters)
  && isRecord(value.safeRatePolicy) && strings(value.safeRatePolicy.numerator) && strings(value.safeRatePolicy.denominator) && strings(value.safeRatePolicy.excluded)
  && Array.isArray(value.scopes) && value.scopes.every(isScope);

const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const validTime = (value: string | null) => (value && stamp.test(value) && !Number.isNaN(Date.parse(value)) ? value : "");
export function parseFilters(search: string): Filters {
  const params = new URLSearchParams(search), mode = params.get("mode");
  return { targetId: params.get("targetId") ?? "", targetVersion: params.get("targetVersion") ?? "", since: validTime(params.get("since")), until: validTime(params.get("until")),
    mode: mode === "selected" || mode === "adaptive" ? mode : "all" };
}
export function filtersQuery(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.targetId) params.set("targetId", filters.targetId);
  if (filters.targetVersion) params.set("targetVersion", filters.targetVersion);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  if (filters.mode !== "all") params.set("mode", filters.mode);
  const query = params.toString();
  return query ? `?${query}` : "";
}
export const reportFilters = (report: CoverageReport): Filters => ({ targetId: report.filters.targetId ?? "", targetVersion: report.filters.targetVersion ?? "", since: report.filters.since ?? "", until: report.filters.until ?? "", mode: report.filters.mode });
export const windowInvalid = (filters: Filters) => !!filters.since && !!filters.until && Date.parse(filters.since) >= Date.parse(filters.until);

export class CoverageError extends Error { constructor(message: string, readonly status: number | null) { super(message); } }
export async function fetchCoverage(query: string): Promise<CoverageReport> {
  let response: Response;
  try { response = await fetch(`/api/coverage/scoped${query}`, { headers: { Accept: "application/json" } }); }
  catch { throw new CoverageError("API unavailable. Check the service and retry.", null); }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new CoverageError(response.status === 404 ? "The selected target was not found. It may have been removed." : response.status === 400 ? "The API rejected these filters as invalid." : `Coverage could not be loaded (HTTP ${response.status}).`, response.status);
  if (!isCoverageReport(payload)) throw new CoverageError("Unexpected response from the coverage API.", null);
  return payload;
}

export const versionLabel = (version: string | null) => (version === null || version === "unknown" ? "version unknown" : `version ${version}`);
export const categoryLabel = (name: string) => { const words = name.replaceAll("_", " "); return words.charAt(0).toUpperCase() + words.slice(1); };
export const fmtTime = (iso: string) => `${iso.slice(0, 16).replace("T", " ")}Z`;
export const scopeKey = (scope: CoverageScope) => JSON.stringify([scope.target.id, scope.targetVersion]);
export const scopeLabel = (scope: CoverageScope) => `${scope.target.name} · ${versionLabel(scope.targetVersion)}`;
export const observedText = (scope: CoverageScope) => scope.observed.firstAt && scope.observed.lastAt ? `Observed ${fmtTime(scope.observed.firstAt)} to ${fmtTime(scope.observed.lastAt)} (UTC)` : "No executions observed in this window";
export const gapInfo: Record<Gap, { label: string; glyph: string; hint: string }> = {
  untested: { label: "Untested", glyph: "○", hint: "No attempt recorded" },
  in_flight: { label: "In flight", glyph: "◔", hint: "Queued or running; counted in no rate" },
  blocked: { label: "Blocked", glyph: "⊘", hint: "Never reached the target" },
  incomplete: { label: "Incomplete", glyph: "!", hint: "Executed but not completed; never safe" },
  inconclusive: { label: "Inconclusive", glyph: "?", hint: "Assessed with no determinate result; never safe" },
};
export const windowText = (filters: Pick<Filters, "since" | "until">) => filters.since && filters.until ? `${fmtTime(filters.since)} to ${fmtTime(filters.until)} (UTC)` : filters.since ? `since ${fmtTime(filters.since)} (UTC)` : filters.until ? `before ${fmtTime(filters.until)} (UTC)` : "all time";
export const modeLabel: Record<Mode, string> = { all: "All modes", selected: "Selected cases only", adaptive: "Adaptive only" };
