import { createContext, useContext } from "react";
import type { useWorkspaceController } from "./controller.js";

export type WorkspaceState = ReturnType<typeof useWorkspaceController>;
export const WorkspaceContext = createContext<WorkspaceState | null>(null);
export function useWorkspace(): WorkspaceState {
  const state = useContext(WorkspaceContext);
  if (!state) throw new Error("Workspace context unavailable");
  return state;
}
