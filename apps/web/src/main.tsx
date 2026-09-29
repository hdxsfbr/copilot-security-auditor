import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { ErrorBoundary } from "./api/ErrorBoundary.js";
import { Workspace } from "./pages/Workspace.js";

createRoot(document.getElementById("root")!).render(<ErrorBoundary name="Application" reloadOnRetry><Workspace /></ErrorBoundary>);
