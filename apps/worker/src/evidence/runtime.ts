import { evidenceCorroborationConfig, type EvidenceCorroborationConfig, type EvidenceProfile } from '../../../../packages/contracts/src/evidence-provider.js';
import { createEvidenceProvider, loadEvidenceConfig, type EvidenceProvider } from './provider.js';

const MAX_CORROBORATION_CONFIG_BYTES = 16_384;
const INVALID = 'Invalid evidence corroboration configuration';
type Enabled = Extract<EvidenceCorroborationConfig, { mode: 'on' }>;
type DeepReadonly<T> = T extends (infer U)[] ? readonly DeepReadonly<U>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** Private worker context. It must never enter events, packets, snapshots or logs. */
export type EvidenceRuntime = Readonly<{
  profile: EvidenceProfile;
  sourceAttestation: Readonly<Enabled['sourceAttestation']>;
  factRegistry: DeepReadonly<NonNullable<Enabled['factRegistry']>> | null;
  redactionValues: readonly string[];
  provider: EvidenceProvider;
}>;

function parseCorroboration(env: NodeJS.ProcessEnv): EvidenceCorroborationConfig {
  const source = env.EVIDENCE_CORROBORATION_CONFIG;
  if (source === undefined) return { mode: 'off' };
  if (Buffer.byteLength(source, 'utf8') > MAX_CORROBORATION_CONFIG_BYTES) throw new Error(INVALID);
  try { return evidenceCorroborationConfig.parse(JSON.parse(source)); }
  catch { throw new Error(INVALID); }
}

/** Construct only after both explicit operator profiles validate; construction sends no HTTP. */
export function loadEvidenceRuntime(
  env: NodeJS.ProcessEnv = process.env,
  deps: { fetch: typeof fetch; resolveSecret?: (ref: 'evidence-http-token') => string | undefined } = { fetch }
): EvidenceRuntime | null {
  const corroboration = parseCorroboration(env);
  if (corroboration.mode === 'off') return null;
  try {
    const evidence = loadEvidenceConfig(env);
    if (evidence.mode !== 'http') throw new Error(INVALID);
    const profile = evidence.profile;
    const binding = corroboration.binding;
    if (binding.profileId !== profile.id || binding.targetId !== profile.targetId ||
      binding.targetVersion !== profile.targetVersion || binding.sourceVersion !== profile.sourceVersion) throw new Error(INVALID);
    const hasFacts = profile.capabilities.includes('seeded_facts');
    if (hasFacts !== !!corroboration.factRegistry) throw new Error(INVALID);
    const provider = createEvidenceProvider(evidence, deps);
    if (!provider) throw new Error(INVALID);
    const registry = corroboration.factRegistry ? Object.freeze({
      completeSeededFacts: corroboration.factRegistry.completeSeededFacts,
      uniqueAcrossSyntheticCharts: corroboration.factRegistry.uniqueAcrossSyntheticCharts,
      charts: Object.freeze(corroboration.factRegistry.charts.map(chart => Object.freeze({
        chartId: chart.chartId, completeAllowedFacts: chart.completeAllowedFacts,
        facts: Object.freeze(chart.facts.map(fact => Object.freeze(fact)))
      })))
    }) : null;
    const redactionValues = registry ? [...new Set(registry.charts.flatMap(chart =>
      chart.facts.flatMap(fact => [fact.value, fact.factId, fact.sourceRecordRef])))] : [];
    // Longer strings first prevent a short record reference from leaving a
    // visible suffix of a longer registered value during replacement.
    redactionValues.sort((a, b) => b.length - a.length);
    return Object.freeze({
      profile: Object.freeze(profile), sourceAttestation: Object.freeze(corroboration.sourceAttestation),
      factRegistry: registry, redactionValues: Object.freeze(redactionValues), provider
    });
  } catch { throw new Error(INVALID); }
}
