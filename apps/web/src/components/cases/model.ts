import { isRecord } from "../../api/client.js";

export type Category = "prompt_injection" | "cross_patient" | "unintended_tool_action";
export type DocumentType = "lab_pdf" | "intake_form";
export type CaseAction =
  | { kind: "chat_turn"; message: string }
  | { kind: "attach_pdf"; message: string; artifactId?: string; documentType: DocumentType };
export type CaseCheck =
  | { kind: "forbidden_patient_disclosure"; version: 1; patientId?: "A" | "B" }
  | { kind: "required_source_citation"; version: 1 }
  | { kind: "forbidden_tool_effect"; version: 1; effect: string };
export type CaseRubric = {
  v: 1; subcategory: string; owaspMappings: string[];
  severity: "low" | "medium" | "high" | "critical" | "unknown";
  severityRationale: string; exploitabilityRationale: string;
  boundary: string; invariant: string; regressionRisk: string;
};
export type CaseDefinition = {
  title: string; category?: Category; user?: "A" | "B";
  expectedSafeBehavior?: string; actions?: CaseAction[]; checks?: CaseCheck[];
  rubric?: Partial<CaseRubric> & { v: 1 };
};
export type CaseRecord = CaseDefinition & {
  id: string; familyId: string; version: number;
  state: "draft" | "published" | "archived";
  authoringMode?: "legacy" | "versioned";
  metadataStatus?: "complete" | "incomplete_draft" | "unknown_legacy";
  createdAt?: string; publishedAt?: string | null; archivedAt?: string | null;
};
export type CaseExecution = {
  runId: string; adaptiveCaseId: string | null;
  status: string; outcome: string | null; targetVersion: string | null;
  caseVersion: number; createdAt: string;
};
export type ActionEditor = { kind: "chat_turn" | "attach_pdf"; message: string; artifactId: string; documentType: DocumentType };
export type CheckEditor = { kind: CaseCheck["kind"]; patientId: "A" | "B"; effect: string };
export type CaseForm = {
  title: string; category: Category | ""; user: "A" | "B";
  expectedSafeBehavior: string; actions: ActionEditor[]; checks: CheckEditor[];
  rubric: CaseRubric; mappingText: string;
};

export const newForm = (): CaseForm => ({
  title: "", category: "", user: "A", expectedSafeBehavior: "",
  actions: [{ kind: "chat_turn", message: "", artifactId: "", documentType: "lab_pdf" }], checks: [],
  rubric: { v: 1, subcategory: "", owaspMappings: [], severity: "unknown", severityRationale: "", exploitabilityRationale: "", boundary: "", invariant: "", regressionRisk: "" },
  mappingText: "",
});
export function formFromRecord(record: CaseRecord): CaseForm {
  const form = newForm();
  form.title = record.title;
  form.category = record.category ?? "";
  form.user = record.user ?? "A";
  form.expectedSafeBehavior = record.expectedSafeBehavior ?? "";
  form.actions = record.actions?.map(action => ({ ...action, artifactId: action.kind === "attach_pdf" ? action.artifactId ?? "" : "", documentType: action.kind === "attach_pdf" ? action.documentType : "lab_pdf" })) ?? [];
  form.checks = record.checks?.map(check => ({ kind: check.kind, patientId: check.kind === "forbidden_patient_disclosure" ? check.patientId ?? "B" : "B", effect: check.kind === "forbidden_tool_effect" ? check.effect : "" })) ?? [];
  if (record.rubric) form.rubric = { ...form.rubric, ...record.rubric };
  form.mappingText = record.rubric?.owaspMappings?.join(", ") ?? "";
  return form;
}
const rubricFields = ["subcategory", "severityRationale", "exploitabilityRationale", "boundary", "invariant", "regressionRisk"] as const;
export function rubricComplete(form: CaseForm): boolean {
  return rubricFields.every(field => form.rubric[field].trim().length > 0);
}
export function previewIssues(form: CaseForm): string[] {
  const issues: string[] = [];
  if (!form.title.trim()) issues.push("Give this case a title.");
  if (!form.category) issues.push("Choose a category.");
  if (!form.expectedSafeBehavior.trim()) issues.push("State the expected safe behavior.");
  if (form.actions.length < 1 || form.actions.length > 3) issues.push("Use one to three actions.");
  form.actions.forEach((action, index) => {
    if (!action.message.trim()) issues.push(`Action ${index + 1} needs a message.`);
    if (action.kind === "attach_pdf" && !action.artifactId) issues.push(`Action ${index + 1} needs an uploaded PDF.`);
  });
  if (form.checks.length > 6) issues.push("Use at most six checks.");
  form.checks.forEach((check, index) => {
    if (check.kind === "forbidden_tool_effect" && !check.effect.trim()) issues.push(`Check ${index + 1} needs a visible effect.`);
  });
  if (!rubricComplete(form)) issues.push("Complete every rubric rationale and boundary field.");
  const mappings = form.mappingText.split(",").map(value => value.trim()).filter(Boolean);
  if (mappings.length > 10 || mappings.some(value => value.length > 120)) issues.push("Use at most ten OWASP mappings, each 120 characters or fewer.");
  return issues;
}
export function definitionFromForm(form: CaseForm, requireComplete = false): CaseDefinition {
  const issues = previewIssues(form);
  if (requireComplete && issues.length) throw new Error(issues.join(" "));
  if (!form.title.trim()) throw new Error("Give this draft a title before saving.");
  const actions = form.actions.map(action => action.kind === "chat_turn"
    ? { kind: "chat_turn" as const, message: action.message.trim() }
    : { kind: "attach_pdf" as const, message: action.message.trim(), ...(action.artifactId ? { artifactId: action.artifactId } : {}), documentType: action.documentType });
  const checks = form.checks.map(check => check.kind === "forbidden_patient_disclosure"
    ? { kind: check.kind, version: 1 as const, patientId: check.patientId }
    : check.kind === "required_source_citation"
      ? { kind: check.kind, version: 1 as const }
      : { kind: check.kind, version: 1 as const, effect: check.effect.trim() });
  const mappings = form.mappingText.split(",").map(value => value.trim()).filter(Boolean);
  return {
    title: form.title.trim(), ...(form.category ? { category: form.category } : {}),
    user: form.user, ...(form.expectedSafeBehavior.trim() ? { expectedSafeBehavior: form.expectedSafeBehavior.trim() } : {}),
    actions, checks,
    rubric: { ...form.rubric, owaspMappings: mappings },
  };
}

const optionalString = (value: unknown) => value === undefined || typeof value === "string";
const nullableString = (value: unknown) => value === null || typeof value === "string";
const isAction = (value: unknown): value is CaseAction => isRecord(value) && typeof value.message === "string" &&
  (value.kind === "chat_turn" || (value.kind === "attach_pdf" && optionalString(value.artifactId) && (value.documentType === "lab_pdf" || value.documentType === "intake_form")));
const isCheck = (value: unknown): value is CaseCheck => isRecord(value) && value.version === 1 &&
  (value.kind === "required_source_citation" || (value.kind === "forbidden_patient_disclosure" && (value.patientId === undefined || value.patientId === "A" || value.patientId === "B")) || (value.kind === "forbidden_tool_effect" && typeof value.effect === "string"));
const isRubric = (value: unknown): value is Partial<CaseRubric> & { v: 1 } => isRecord(value) && value.v === 1 &&
  ["subcategory", "severityRationale", "exploitabilityRationale", "boundary", "invariant", "regressionRisk"].every(key => optionalString(value[key])) &&
  (value.owaspMappings === undefined || (Array.isArray(value.owaspMappings) && value.owaspMappings.every(item => typeof item === "string"))) &&
  (value.severity === undefined || value.severity === "low" || value.severity === "medium" || value.severity === "high" || value.severity === "critical" || value.severity === "unknown");
export const isCaseRecord = (value: unknown): value is CaseRecord => isRecord(value) &&
  typeof value.id === "string" && typeof value.familyId === "string" && Number.isInteger(value.version) &&
  (value.state === "draft" || value.state === "published" || value.state === "archived") && typeof value.title === "string" &&
  (value.category === undefined || value.category === "prompt_injection" || value.category === "cross_patient" || value.category === "unintended_tool_action") &&
  (value.user === undefined || value.user === "A" || value.user === "B") && optionalString(value.expectedSafeBehavior) &&
  (value.actions === undefined || (Array.isArray(value.actions) && value.actions.every(isAction))) &&
  (value.checks === undefined || (Array.isArray(value.checks) && value.checks.every(isCheck))) &&
  (value.rubric === undefined || isRubric(value.rubric)) &&
  (value.metadataStatus === undefined || value.metadataStatus === "complete" || value.metadataStatus === "incomplete_draft" || value.metadataStatus === "unknown_legacy") &&
  (value.authoringMode === undefined || value.authoringMode === "legacy" || value.authoringMode === "versioned") &&
  optionalString(value.createdAt) && (value.publishedAt === undefined || nullableString(value.publishedAt)) &&
  (value.archivedAt === undefined || nullableString(value.archivedAt));
export const isCaseRecords = (value: unknown): value is CaseRecord[] => Array.isArray(value) && value.every(isCaseRecord);
export const isExecutions = (value: unknown): value is CaseExecution[] => Array.isArray(value) && value.every(item => isRecord(item) &&
  typeof item.runId === "string" && typeof item.status === "string" && Number.isInteger(item.caseVersion) &&
  nullableString(item.adaptiveCaseId) && nullableString(item.outcome) && nullableString(item.targetVersion) && typeof item.createdAt === "string");
export const isArtifact = (value: unknown): value is { id: string } => isRecord(value) && typeof value.id === "string";
