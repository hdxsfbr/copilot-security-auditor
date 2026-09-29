import React from "react";
import { ErrorBoundary } from "../api/ErrorBoundary.js";
import { ScheduleDesk } from "../ScheduleDesk.js";
import { useWorkspace } from "./context.js";

export function SchedulesPage({ active }: { active: boolean }) {
  const { targets, cases, navigate } = useWorkspace();
  return <ErrorBoundary name="Scheduled evaluations"><ScheduleDesk active={active} targets={targets} cases={cases} navigate={navigate} /></ErrorBoundary>;
}
