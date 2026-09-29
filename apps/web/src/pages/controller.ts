import { useEffect, useRef, useState } from "react";
import { isRecord, isRecordArray, requestJson } from "../api/client.js";
import { appendNewerEvents, drainEventPages } from "./run-events.js";

type Target = {
  id: string;
  name: string;
  baseUrl: string;
  activeRunId: string | null;
};
type EditableTarget = Pick<Target, "id" | "name" | "baseUrl"> & {
  userA: { username: string; pubpid: string };
  userB: { username: string; pubpid: string };
};
type Case = {
  id: string;
  title: string;
  category?: string;
  user: string;
  expectedSafeBehavior: string;
  actions: {
    kind: string;
    message: string;
    artifactId?: string;
    documentType?: string;
  }[];
};
export type Run = {
  id: string;
  caseId?: string;
  status: string;
  outcome: string | null;
  version: string | null;
  model: string;
  modelSnapshot?: { roles: { judge: { provider: string; model: string } } };
  categories?: string[] | null;
  stopRequested?: boolean;
  mode?: "selected" | "adaptive";
  target?: { id: string; name: string | null; version: string | null };
  caseSnapshot?: { id: string; familyId: string | null; version: number | null; definition: Record<string, unknown> | null } | null;
  adaptiveSeeds?: { id: string; familyId: string | null; version: number | null; definition: Record<string, unknown> }[] | null;
  createdAt?: string; startedAt?: string | null; finishedAt?: string | null;
};
export type Event = {
  id: number | string;
  event: { agent: string; kind: string; detail: Record<string, unknown> };
  createdAt: string;
};
type Finding = {
  id: string;
  runId: string;
  state: string;
  title: string;
  version: string | null;
  decisionRoute: string | null;
  exportApprovedAt: string | null;
};
type Regression = {
  id: string;
  sourceRunId: string;
  version: string | null;
  definition: { title: string };
  replays: { runId: string; version: string | null; outcome: string }[];
};
type Coverage = { category: string; outcome: string; count: number };
const isString = (value: unknown): value is string => typeof value === "string";
const isNullableString = (value: unknown): value is string | null => value === null || isString(value);
const isTarget = (value: unknown): value is Target => isRecord(value) && isString(value.id) && isString(value.name) && isString(value.baseUrl) && isNullableString(value.activeRunId);
const isEditableTarget = (value: unknown): value is EditableTarget => isRecord(value) && isString(value.id) && isString(value.name) && isString(value.baseUrl) && isRecord(value.userA) && isString(value.userA.username) && isString(value.userA.pubpid) && isRecord(value.userB) && isString(value.userB.username) && isString(value.userB.pubpid);
const isCase = (value: unknown): value is Case => isRecord(value) && isString(value.id) && isString(value.title) && isString(value.user) && isString(value.expectedSafeBehavior) && Array.isArray(value.actions) && value.actions.every(action => isRecord(action) && isString(action.kind) && isString(action.message));
const isFinding = (value: unknown): value is Finding => isRecord(value) && isString(value.id) && isString(value.runId) && isString(value.state) && isString(value.title) && isNullableString(value.version) && isNullableString(value.decisionRoute) && isNullableString(value.exportApprovedAt);
const isRegression = (value: unknown): value is Regression => isRecord(value) && isString(value.id) && isString(value.sourceRunId) && isNullableString(value.version) && isRecord(value.definition) && isString(value.definition.title) && Array.isArray(value.replays) && value.replays.every(replay => isRecord(replay) && isString(replay.runId) && isNullableString(replay.version) && isString(replay.outcome));
const isCoverage = (value: unknown): value is Coverage => isRecord(value) && isString(value.category) && isString(value.outcome) && typeof value.count === "number";
const isSavedCase = (v: unknown): v is NonNullable<Run["caseSnapshot"]> => isRecord(v) && isString(v.id) && isNullableString(v.familyId) && (v.version === null || Number.isInteger(v.version)) && (v.definition === null || isRecord(v.definition));
const isSeed = (v: unknown): v is NonNullable<Run["adaptiveSeeds"]>[number] => isRecord(v) && isString(v.id) && isNullableString(v.familyId) && (v.version === null || Number.isInteger(v.version)) && isRecord(v.definition);
const isRun = (value: unknown): value is Run => isRecord(value) && isString(value.id) && isString(value.status) && isNullableString(value.outcome) && isNullableString(value.version) && isString(value.model) && (value.caseId === undefined || isNullableString(value.caseId)) && (value.categories === undefined || value.categories === null || (Array.isArray(value.categories) && value.categories.every(isString))) && (value.stopRequested === undefined || typeof value.stopRequested === "boolean") && (value.mode === undefined || value.mode === "selected" || value.mode === "adaptive") && (value.target === undefined || (isRecord(value.target) && isString(value.target.id) && isNullableString(value.target.name) && isNullableString(value.target.version))) && (value.caseSnapshot === undefined || value.caseSnapshot === null || isSavedCase(value.caseSnapshot)) && (value.adaptiveSeeds === undefined || value.adaptiveSeeds === null || (Array.isArray(value.adaptiveSeeds) && value.adaptiveSeeds.every(isSeed))) && (value.modelSnapshot === undefined || value.modelSnapshot === null || (isRecord(value.modelSnapshot) && isRecord(value.modelSnapshot.roles) && isRecord(value.modelSnapshot.roles.judge) && isString(value.modelSnapshot.roles.judge.provider) && isString(value.modelSnapshot.roles.judge.model)));
const isConfig = (value: unknown): value is { ollamaUrl: string; model: string } => isRecord(value) && isString(value.ollamaUrl) && isString(value.model);
const isSavedTarget = (value: unknown): value is Pick<Target, "id" | "name" | "baseUrl"> => isRecord(value) && isString(value.id) && isString(value.name) && isString(value.baseUrl);
const isCaseSelection = (value: unknown): value is { caseId: string | null } => isRecord(value) && isNullableString(value.caseId);
const isSelectedCase = (value: unknown): value is { caseId: string } => isRecord(value) && isString(value.caseId);
const targetsGuard = isRecordArray(isTarget), casesGuard = isRecordArray(isCase), findingsGuard = isRecordArray(isFinding), regressionsGuard = isRecordArray(isRegression), coverageGuard = isRecordArray(isCoverage);
const api = requestJson;
export function useWorkspaceController(navigate: (path: string) => void) {
  const [targets, setTargets] = useState<Target[]>([]),
    [cases, setCases] = useState<Case[]>([]);
  const [run, setRun] = useState<Run | null>(null),
    [events, setEvents] = useState<Event[]>([]);
  const activeRunId = useRef<string | null>(null);
  const runGeneration = useRef(0);
  const pollSequence = useRef(0);
  const eventCursor = useRef<string | null>(null);
  const [notice, setNotice] = useState(""),
    [targetId, setTargetId] = useState(
      () => localStorage.getItem("selectedTargetId") ?? "",
    ),
    [caseId, setCaseId] = useState("");
  const [noticeKind, setNoticeKind] = useState<"error" | "success">("error"),
    [editingTargetId, setEditingTargetId] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [configError, setConfigError] = useState("");
  const [runError, setRunError] = useState("");
  const [caseHandoff, setCaseHandoff] = useState<{ caseId: string; sequence: number } | null>(null);
  const [loadedTargetId, setLoadedTargetId] = useState("");
  const [targetLoadFailed, setTargetLoadFailed] = useState(false);
  const [findings, setFindings] = useState<Finding[]>([]),
    [regressions, setRegressions] = useState<Regression[]>([]),
    [coverage, setCoverage] = useState<Coverage[]>([]);
  const [exported, setExported] = useState("");
  const [target, setTarget] = useState({
    name: "Toy Co-Pilot",
    baseUrl: "",
    aUser: "",
    aPass: "",
    aPubpid: "",
    bUser: "",
    bPass: "",
    bPubpid: "",
  });
  // Server defaults for new run definitions; the composer owns the editable draft.
  const [model, setModel] = useState(""),
    [ollamaUrl, setOllamaUrl] = useState("");
  useEffect(() => {
    if (!editingTargetId) return;
    let active = true;
    void api(`/targets/${editingTargetId}/edit`, isEditableTarget)
      .then((saved) => {
        if (active) {
          setTarget({
            name: saved.name,
            baseUrl: saved.baseUrl,
            aUser: saved.userA.username,
            aPass: "",
            aPubpid: saved.userA.pubpid,
            bUser: saved.userB.username,
            bPass: "",
            bPubpid: saved.userB.pubpid,
          });
          setLoadedTargetId(saved.id);
        }
      })
      .catch((e) => {
        if (active) {
          setTargetLoadFailed(true);
          setNoticeKind("error");
          setNotice(e instanceof Error ? e.message : "Could not load target");
        }
      });
    return () => {
      active = false;
    };
  }, [editingTargetId]);
  const refresh = async () => {
    try {
      const [t, c, f, r, gaps] = await Promise.all([
        api("/targets", targetsGuard),
        api("/cases", casesGuard),
        api("/findings", findingsGuard),
        api("/regressions", regressionsGuard),
        api("/coverage", coverageGuard),
      ]);
      setTargets(t);
      setCases(c);
      setFindings(f);
      setRegressions(r);
      setCoverage(gaps);
      setRefreshError("");
      setTargetId((v) => (t.some((target) => target.id === v) ? v : ""));
      setCaseId((v) =>
        c.some((testCase) => testCase.id === v) ? v : c[0]?.id || "",
      );
    } catch (e) {
      setRefreshError(
        e instanceof Error ? e.message : "Could not load saved targets",
      );
    }
  };
  const loadConfig = async () => {
    try {
      const config = await api("/config", isConfig);
      setOllamaUrl(config.ollamaUrl);
      setModel(config.model);
      setConfigError("");
    } catch (cause) {
      setConfigError(cause instanceof Error ? cause.message : "Model defaults unavailable");
    }
  };
  const pollRun = async (id = run?.id) => {
    if (!id) return;
    const generation = runGeneration.current;
    const request = ++pollSequence.current;
    const current = () => activeRunId.current === id && runGeneration.current === generation && pollSequence.current === request;
    try {
      // Status is read before evidence: a run seen as finished has already committed its final events, so draining afterwards cannot miss them.
      const nextRun = await api(`/runs/${id}`, isRun);
      if (!current()) return;
      if (nextRun.id !== id) throw new Error("Run identity does not match the requested URL");
      // Each accepted page is committed immediately, so a failure on a later page keeps earlier evidence and the cursor for the next attempt.
      await drainEventPages(id, eventCursor.current, (items, cursor) => {
        eventCursor.current = cursor;
        setEvents(shown => appendNewerEvents(shown, items));
      }, current);
      if (!current()) return;
      setRun(nextRun);
      setRunError("");
    } catch (cause) {
      if (activeRunId.current === id && runGeneration.current === generation && pollSequence.current === request) setRunError(cause instanceof Error ? cause.message : "Run progress unavailable");
    }
  };
  useEffect(() => {
    if (targetId) localStorage.setItem("selectedTargetId", targetId);
    else localStorage.removeItem("selectedTargetId");
  }, [targetId]);
  useEffect(() => {
    refresh();
    void loadConfig();
  }, []);
  useEffect(() => {
    if (run?.status === "finished") void refresh();
  }, [run?.status, run?.id]);
  const submit = async (work: () => Promise<unknown>) => {
    setNotice("");
    setNoticeKind("error");
    try {
      await work();
      await refresh();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Request failed");
    }
  };
  const actOnFinding = async (
    id: string,
    action: "confirm" | "reject" | "approve",
  ) => {
    await submit(async () => {
      if (action === "approve") {
        await api(`/findings/${id}/approve-export`, isRecord, { method: "POST" });
        setExported(
          JSON.stringify(await api(`/findings/${id}/export`, isRecord), null, 2),
        );
      } else
        await api(`/findings/${id}/review`, isRecord, {
          method: "POST",
          body: JSON.stringify({ decision: action }),
        });
    });
  };
  const saveTarget = async () => {
    setNotice("");
    const input = {
      name: target.name,
      baseUrl: target.baseUrl,
      userA: {
        username: target.aUser,
        pubpid: target.aPubpid,
        ...(target.aPass ? { password: target.aPass } : {}),
      },
      userB: {
        username: target.bUser,
        pubpid: target.bPubpid,
        ...(target.bPass ? { password: target.bPass } : {}),
      },
    };
    try {
      const saved = await api(
        editingTargetId ? `/targets/${editingTargetId}` : "/targets",
        isSavedTarget,
        {
          method: editingTargetId ? "PUT" : "POST",
          body: JSON.stringify(input),
        },
      );
      setEditingTargetId(saved.id);
      setLoadedTargetId(saved.id);
      setTargetId(saved.id);
      setTarget((current) => ({
        ...current,
        name: saved.name,
        baseUrl: saved.baseUrl,
        aPass: "",
        bPass: "",
      }));
      setNoticeKind("success");
      setNotice(
        `Target ${editingTargetId ? "updated" : "created"} and selected for the next run.`,
      );
      refresh();
    } catch (e) {
      setNoticeKind("error");
      setNotice(e instanceof Error ? e.message : "Request failed");
    }
  };
  const openRun = (id: string, label = "loading", version: string | null = null, changeRoute = true) => {
    if (activeRunId.current !== id) {
      runGeneration.current++;
      pollSequence.current++;
      activeRunId.current = id;
      eventCursor.current = null;
      setRun({ id, status: "loading", outcome: null, version, model: label });
      setEvents([]);
      setRunError("");
    }
    if (changeRoute) navigate(`/runs/${encodeURIComponent(id)}`);
  };
  const deactivateRun = () => { runGeneration.current++; pollSequence.current++; };
  const selectRegression = async (id: string, sourceRunId: string) => {
    const source = findings.find(finding => finding.runId === sourceRunId);
    if (!source) return;
    try {
      const record = await api(`/runs/${source.runId}`, isCaseSelection);
      const selected = record.caseId ?? (await api(`/regressions/${id}/select`, isSelectedCase, { method: "POST" })).caseId;
      await refresh();
      setCaseId(selected);
      setCaseHandoff(current => ({ caseId: selected, sequence: (current?.sequence ?? 0) + 1 }));
      setNoticeKind("success");
      setNotice(record.caseId ? "Original case selected for a new replay. Choose a target and launch." : "Adaptive regression case selected for replay. Choose a target and launch.");
      navigate("/runs/new");
    } catch (error) { setNoticeKind("error"); setNotice(String(error)); }
  };
  return { targets, cases, run, events, notice, noticeKind, targetId, setTargetId, caseId, setCaseId,
    editingTargetId, setEditingTargetId, refreshError, configError, runError, caseHandoff,
    loadedTargetId, setLoadedTargetId, targetLoadFailed, setTargetLoadFailed,
    findings, regressions, coverage, exported,
    target, setTarget, model, ollamaUrl,
    setNotice, setNoticeKind, refresh, loadConfig, pollRun, submit, actOnFinding, saveTarget,
    openRun, deactivateRun, selectRun: openRun, selectRegression, navigate };
}
