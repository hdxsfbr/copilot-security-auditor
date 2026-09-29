import React from "react";
import { RouteLink } from "./router.js";

export const navigation = [
  { href: "/", label: "Overview" },
  { href: "/targets", label: "Targets" },
  { href: "/cases", label: "Cases" },
  { href: "/runs/new", label: "Launch" },
  { href: "/runs", label: "Runs" },
  { href: "/findings", label: "Findings" },
  { href: "/regressions", label: "Regressions" },
  { href: "/coverage", label: "Coverage" },
  { href: "/schedules", label: "Schedules" },
] as const;

export function AppShell({ path, navigate, title, description, runId, children }: React.PropsWithChildren<{ path: string; navigate: (path: string) => void; title: string; description: string; runId?: string }>) {
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <header className="app-header">
      <RouteLink href="/" navigate={navigate} className="brand" aria-label="Clinical Auditor overview">
        <span className="mark">C/A</span><span>CLINICAL AUDITOR <small>CONTROL ROOM / 01</small></span>
      </RouteLink>
      <span className="environment">● &nbsp; TRUSTED LAN ONLY</span>
    </header>
    <div className="app-frame">
      <nav className="app-nav" aria-label="Primary navigation">
        <span className="nav-caption">WORKSPACE</span>
        {navigation.map(item => <RouteLink key={item.href} href={item.href} navigate={navigate}
          aria-current={path === item.href || item.href === "/findings" && path.startsWith("/findings/") ? "page" : undefined} className={path === item.href || item.href === "/findings" && path.startsWith("/findings/") ? "nav-link active" : "nav-link"}>{item.label}</RouteLink>)}
        {runId && <RouteLink href={`/runs/${runId}`} navigate={navigate} aria-current={path === `/runs/${runId}` ? "page" : undefined}
          className={path === `/runs/${runId}` ? "nav-link active" : "nav-link"}>Current run</RouteLink>}
      </nav>
      <main id="main-content" tabIndex={-1}>
        <div className="page-intro"><div className="eyebrow">CLINICAL AUDITOR / WORKSPACE</div><h1>{title}</h1><p>{description}</p></div>
        {children}
        <footer>PHASE 02 / THREE TRUST BOUNDARIES <span>CONFIRMED ≠ PUBLISHED &nbsp;·&nbsp; INCOMPLETE ≠ SAFE</span></footer>
      </main>
    </div>
  </div>;
}
