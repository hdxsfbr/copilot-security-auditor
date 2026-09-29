import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { publishedAgentSchemas } from '../packages/contracts/src/agent.js';

export const schemaFiles = {
  orchestratorToRedTeam: 'orchestrator-to-red-team.schema.json',
  redTeamToJudge: 'red-team-to-judge.schema.json',
  judgeToDocumentation: 'judge-to-documentation.schema.json'
} as const;
export function publishedSchemaText(name: keyof typeof schemaFiles): string {
  return `${JSON.stringify(z.toJSONSchema(publishedAgentSchemas[name]), null, 2)}\n`;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const name of Object.keys(schemaFiles) as (keyof typeof schemaFiles)[]) {
    writeFileSync(new URL(`./v1/${schemaFiles[name]}`, import.meta.url), publishedSchemaText(name));
  }
}
