import React, { useId } from "react";

// An explicitly associated label, so a control's accessible name is exactly its label text (a wrapping label would include every option's text).
export function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return <div className="cov-field"><label htmlFor={id}>{label}</label>{children(id)}</div>;
}
