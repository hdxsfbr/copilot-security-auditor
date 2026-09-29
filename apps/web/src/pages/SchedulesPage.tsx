import React from "react";
import { ErrorBoundary } from "../api/ErrorBoundary.js";
import { ScheduleDesk } from "../ScheduleDesk.js";
import { useWorkspace } from "./context.js";

export function SchedulesPage() {
  const { targets, cases, selectRun } = useWorkspace();
  return <ErrorBoundary name="Scheduled evaluations"><ScheduleDesk targets={targets} cases={cases} onInspect={id => selectRun(id, "scheduled")} /></ErrorBoundary>;
}
