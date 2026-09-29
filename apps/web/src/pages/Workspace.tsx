import React, { useEffect } from "react";
import { ErrorBoundary } from "../api/ErrorBoundary.js";
import { AppShell } from "../components/AppShell.js";
import { RunActivity } from "../components/RunActivity.js";
import { SpendPanel } from "../components/spend/SpendPanel.js";
import { useRouterPath } from "../components/router.js";
import { CasesPage } from "./CasesPage.js";
import { WorkspaceContext } from "./context.js";
import { useWorkspaceController } from "./controller.js";
import { CoveragePage } from "./CoveragePage.js";
import { FindingDetailPage } from "./FindingDetailPage.js";
import { FindingsPage } from "./FindingsPage.js";
import { OverviewPage } from "./OverviewPage.js";
import { RegressionsPage } from "./RegressionsPage.js";
import { RunComposer } from "./RunComposer.js";
import { RunDetailPage } from "./RunDetailPage.js";
import { RunsPage } from "./RunsPage.js";
import { SchedulesPage } from "./SchedulesPage.js";
import { TargetsPage } from "./TargetsPage.js";

const pageInfo: Record<string, { title: string; description: string }> = {
  "/": { title: "Overview", description: "See current work and move directly to the task you need." },
  "/targets": { title: "Targets & identities", description: "Configure authorized synthetic target connections and their chart identities." },
  "/cases": { title: "Cases", description: "Save a scoped synthetic test case and optional PDF for later evaluation." },
  "/runs/new": { title: "Launch evaluation", description: "Compose and preflight a saved evaluation." },
  "/runs": { title: "Runs", description: "Recover saved evaluations and inspect their exact evidence." },
  "/findings": { title: "Findings & review", description: "Inspect reviewable observations and make explicit decisions." },
  "/regressions": { title: "Regressions", description: "Select a confirmed definition for a new replay." },
  "/coverage": { title: "Coverage", description: "See tested outcomes and visible gaps by category." },
  "/schedules": { title: "Schedules", description: "Create, pause and inspect recurring evaluations." },
};

export function Workspace() {
  const { path, navigate } = useRouterPath();
  const state = useWorkspaceController(navigate);
  const caseRouteId = /^\/cases\/([^/]+)$/.exec(path)?.[1];
  const findingRouteId = /^\/findings\/([^/]+)$/.exec(path)?.[1];
  const runMatch = /^\/runs\/([^/]+)(?:\/cases\/([^/]+))?$/.exec(path);
  const runRouteId = path === "/runs/new" ? undefined : runMatch?.[1];
  const executionCaseId = runMatch?.[2];
  useEffect(() => {
    if (!runRouteId) return;
    if (state.run?.id !== runRouteId) state.openRun(runRouteId, "loading", null, false);
    void state.pollRun(runRouteId);
    return () => state.deactivateRun();
  }, [runRouteId]);
  useEffect(() => {
    if (!runRouteId || state.run?.id !== runRouteId || state.run.status === "finished") return;
    const timer = setInterval(() => { if (!document.hidden) void state.pollRun(runRouteId); }, 1500);
    return () => clearInterval(timer);
  }, [runRouteId, state.run?.id, state.run?.status]);
  const info = findingRouteId ? { title: "Finding review", description: "Review the exact evidence, decide, then approve and download a redacted report revision." } : caseRouteId ? { title: "Case workspace", description: "Edit a draft or inspect the exact published version and its executions." } : runRouteId ? { title: "Run evidence", description: "Inspect the selected run's current status and recorded events." } : pageInfo[path] ?? { title: "Page unavailable", description: "This workspace path is not available yet." };
  return <WorkspaceContext.Provider value={state}>
    <AppShell path={path} navigate={navigate} title={info.title} description={info.description} runId={state.run?.id}>
      {state.notice && <div className="alert" role={state.noticeKind === "error" ? "alert" : "status"}>{state.notice}</div>}
      {state.refreshError && <div className="alert" role="alert">Saved targets, cases, and evidence could not be refreshed: {state.refreshError} <button type="button" onClick={() => void state.refresh()}>Retry data refresh</button></div>}
      {state.configError && <div className="alert" role="alert">Model defaults unavailable: {state.configError} <button type="button" onClick={() => void state.loadConfig()}>Retry model defaults</button></div>}
      <div hidden={path !== "/"} className="route-panel"><OverviewPage active={path === "/"} /></div>
      {path === "/" && <div className="route-panel"><ErrorBoundary name="Spend reconciliation"><SpendPanel /></ErrorBoundary></div>}
      <div hidden={path !== "/targets"} className="route-panel"><TargetsPage /></div>
      <div hidden={path !== "/cases" && !caseRouteId} className="route-panel"><CasesPage selectedId={caseRouteId} active={path === "/cases" || !!caseRouteId} /></div>
      <div hidden={path !== "/runs/new"} className="route-panel launch-stack">
        <ErrorBoundary name="Run composer"><RunComposer active={path === "/runs/new"} /></ErrorBoundary>
      </div>
      {path === "/runs" && <div className="route-panel"><RunsPage /></div>}
      {runRouteId && runRouteId === state.run?.id && <div className="route-panel"><RunActivity key={state.run.id} /></div>}
      {runRouteId && <div className="route-panel">{state.run?.id === runRouteId ? <RunDetailPage runId={runRouteId} executionCaseId={executionCaseId} /> : <p role="status">Loading run evidence…</p>}</div>}
      {path === "/runs/new" && state.run?.id && <div className="route-panel"><RunActivity key={state.run.id} /></div>}
      {path === "/findings" && <div className="route-panel"><FindingsPage /></div>}
      {findingRouteId && <div className="route-panel"><ErrorBoundary name="Finding review"><FindingDetailPage key={findingRouteId} findingId={decodeURIComponent(findingRouteId)} /></ErrorBoundary></div>}
      <div hidden={path !== "/regressions"} className="route-panel"><RegressionsPage /></div>
      <div hidden={path !== "/coverage"} className="route-panel"><CoveragePage /></div>
      <div hidden={path !== "/schedules"} className="route-panel"><SchedulesPage active={path === "/schedules"} /></div>
      {!runRouteId && !caseRouteId && !findingRouteId && !pageInfo[path] && <div className="panel" role="status">This route has no operator task yet. Use the navigation to open an available page.</div>}
    </AppShell>
  </WorkspaceContext.Provider>;
}
