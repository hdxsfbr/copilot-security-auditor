import React, { useEffect } from "react";
import { ErrorBoundary } from "../api/ErrorBoundary.js";
import { ModelDesk } from "../ModelDesk.js";
import { AppShell } from "../components/AppShell.js";
import { RunActivity } from "../components/RunActivity.js";
import { useRouterPath } from "../components/router.js";
import { CasesPage } from "./CasesPage.js";
import { WorkspaceContext } from "./context.js";
import { useWorkspaceController } from "./controller.js";
import { CoveragePage } from "./CoveragePage.js";
import { FindingsPage } from "./FindingsPage.js";
import { LegacyRunLauncher } from "./LegacyRunLauncher.js";
import { OverviewPage } from "./OverviewPage.js";
import { RegressionsPage } from "./RegressionsPage.js";
import { RunDetailPage } from "./RunDetailPage.js";
import { SchedulesPage } from "./SchedulesPage.js";
import { TargetsPage } from "./TargetsPage.js";

const pageInfo: Record<string, { title: string; description: string }> = {
  "/": { title: "Overview", description: "See current work and move directly to the task you need." },
  "/targets": { title: "Targets & identities", description: "Configure authorized synthetic target connections and their chart identities." },
  "/cases": { title: "Cases", description: "Save a scoped synthetic test case and optional PDF for later evaluation." },
  "/runs/new": { title: "Launch evaluation", description: "Select a saved target and case, then choose the current launch path." },
  "/findings": { title: "Findings & review", description: "Inspect reviewable observations and make explicit decisions." },
  "/regressions": { title: "Regressions", description: "Select a confirmed definition for a new replay." },
  "/coverage": { title: "Coverage", description: "See tested outcomes and visible gaps by category." },
  "/schedules": { title: "Schedules", description: "Create, pause and inspect recurring evaluations." },
};

export function Workspace() {
  const { path, navigate } = useRouterPath();
  const state = useWorkspaceController(navigate);
  const caseRouteId = /^\/cases\/([^/]+)$/.exec(path)?.[1];
  const runRouteId = path === "/runs/new" ? undefined : /^\/runs\/([^/]+)$/.exec(path)?.[1];
  useEffect(() => {
    if (runRouteId && state.run?.id !== runRouteId) state.openRun(runRouteId, "loading", null, false);
  }, [runRouteId]);
  const info = caseRouteId ? { title: "Case workspace", description: "Edit a draft or inspect the exact published version and its executions." } : runRouteId ? { title: "Run evidence", description: "Inspect the selected run's current status and recorded events." } : pageInfo[path] ?? { title: "Page unavailable", description: "This workspace path is not available yet." };
  return <WorkspaceContext.Provider value={state}>
    <AppShell path={path} navigate={navigate} title={info.title} description={info.description} runId={state.run?.id}>
      {state.notice && <div className="alert" role={state.noticeKind === "error" ? "alert" : "status"}>{state.notice}</div>}
      {state.refreshError && <div className="alert" role="alert">Saved targets, cases, and evidence could not be refreshed: {state.refreshError} <button type="button" onClick={() => void state.refresh()}>Retry data refresh</button></div>}
      {state.configError && <div className="alert" role="alert">Model defaults unavailable: {state.configError} <button type="button" onClick={() => void state.loadConfig()}>Retry model defaults</button></div>}
      <div hidden={path !== "/"} className="route-panel"><OverviewPage /></div>
      <div hidden={path !== "/targets"} className="route-panel"><TargetsPage /></div>
      <div hidden={path !== "/cases" && !caseRouteId} className="route-panel"><CasesPage selectedId={caseRouteId} active={path === "/cases" || !!caseRouteId} /></div>
      <div hidden={path !== "/runs/new"} className="route-panel launch-stack">
        <LegacyRunLauncher />
        <ErrorBoundary name="Model settings"><ModelDesk targetId={state.targetId} caseId={state.caseId} cases={state.cases}
          onStart={id => state.openRun(id, "assigned per role")} /></ErrorBoundary>
      </div>
      {runRouteId && <div className="route-panel">{state.run?.id === runRouteId ? <RunDetailPage /> : <p role="status">Loading run evidence…</p>}</div>}
      <div hidden={path !== "/runs/new" && (!runRouteId || state.run?.id !== runRouteId)} className="route-panel"><RunActivity key={state.run?.id ?? "none"} /></div>
      <div hidden={path !== "/findings"} className="route-panel"><FindingsPage /></div>
      <div hidden={path !== "/regressions"} className="route-panel"><RegressionsPage /></div>
      <div hidden={path !== "/coverage"} className="route-panel"><CoveragePage /></div>
      <div hidden={path !== "/schedules"} className="route-panel"><SchedulesPage /></div>
      {!runRouteId && !caseRouteId && !pageInfo[path] && <div className="panel" role="status">This route has no operator task yet. Use the navigation to open an available page.</div>}
    </AppShell>
  </WorkspaceContext.Provider>;
}
