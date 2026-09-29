import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { publishedAgentSchemas } from '../packages/contracts/src/agent.js';
import { documentationReport } from '../packages/contracts/src/report.js';

// The Documentation output is a Zod-authored v1 contract like the envelopes; F01 validates it strictly before any storage.
const published = { ...publishedAgentSchemas, documentationReport } as const;

export const schemaFiles = {
  orchestratorToRedTeam: 'orchestrator-to-red-team.schema.json',
  redTeamToJudge: 'red-team-to-judge.schema.json',
  judgeToDocumentation: 'judge-to-documentation.schema.json',
  documentationReport: 'documentation-report.schema.json'
} as const;
export function publishedSchemaText(name: keyof typeof schemaFiles): string {
  return `${JSON.stringify(z.toJSONSchema(published[name]), null, 2)}\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const name of Object.keys(schemaFiles) as (keyof typeof schemaFiles)[]) {
    writeFileSync(new URL(`./v1/${schemaFiles[name]}`, import.meta.url), publishedSchemaText(name));
  }
}
