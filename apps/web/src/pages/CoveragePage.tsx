import React from "react";
import { useWorkspace } from "./context.js";

export function CoveragePage() {
  const { coverage } = useWorkspace();
  return <section className="panel" aria-labelledby="coverage-heading">
    <div className="eyebrow">TESTED VS UNKNOWN</div>
    <h2 id="coverage-heading">Coverage</h2>
    {(["prompt_injection", "cross_patient", "unintended_tool_action"] as const).map(category =>
      <article className="review-item" key={category}>
        <strong>{category.replaceAll("_", " ")}</strong>
        <p>{coverage.filter(item => item.category === category).map(item => `${item.outcome}: ${item.count}`).join(" · ") || "Untested / coverage gap"}</p>
      </article>)}
  </section>;
}
