import React from 'react';
import type { RegressionState } from '../../../../../packages/contracts/src/regression-states.js';
import { stateInfo, versionText } from './model.js';

export function StateChip({ state, version }: { state: RegressionState; version?: string | null }) {
  const info = stateInfo[state];
  return <span className={`state-chip state-${state}`}><span aria-hidden="true">{info.glyph}</span> {info.label}{version !== undefined && <span className="state-version"> · {versionText(version)}</span>}</span>;
}
