# "The coolest parts of this project" — a walk-through

A rehearsal script for walking an interviewer through the Clinical Co-Pilot
Auditor. It follows **one adaptive attack from birth to verdict**, stopping at
the parts worth talking about. Each beat has a "say this" line and a direct link
to the function on the `chore/prettier-core-readability` branch (line anchors
reflect commit `b314210`).

Open each file as you hit the beat; the links jump straight to the function.

**Repo:** `labs.gauntletai.com/andrebatista/copilot-security-auditor` · branch `chore/prettier-core-readability`

**One narrative tip:** the spine is Beat 1 → 5 → 8 (birth → judgment → honest
result). If you only get two minutes, do those three. The admission gate (3),
retry contract (4), and feedback loop (7) are your "pull a thread" bonuses.

---

## The 20-second hook (lead with this)

> "It's an automated red-teamer for a clinical AI assistant. The one idea the
> whole thing is built around is: **the language models only ever *propose* —
> deterministic code decides everything that matters.** Four LLM roles suggest
> attacks and verdicts, but nothing a model says reaches the target, becomes a
> finding, or ships in a report until plain, testable TypeScript has validated
> it. So let me walk one attack through the system."

---

## Beat 1 — A run is born (concurrency done right)

> "When an operator launches a run, the API doesn't just kick off work — it
> takes an immutable **snapshot** (target, seeds, verified model pricing —
> credentials stored as *references*, never plaintext) and reserves the target.
> A worker then claims it with `FOR UPDATE SKIP LOCKED` and a lease generation,
> so exactly one worker owns it and a zombie worker gets fenced out."

- [`repository.ts` → `startAdaptive`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/api/src/repository.ts#L1287)
- [`repository.ts` → `claim`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/api/src/repository.ts#L1909)

## Beat 2 — The loop that's actually *steered* (not a model winging it)

> "For adaptive runs there's a loop, but the intelligence about *what to attack
> next* lives in deterministic code, not the model. It ranks candidate seeds by
> **regression state first, then unresolved severity, then coverage gaps** — and
> parks a category that keeps going nowhere. The model just picks from a
> shortlist the code already ranked."

- [`adaptive.ts` → `processAdaptive`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/adaptive.ts#L400) (the loop)
- [`adaptive.ts` → `planSelection`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/adaptive.ts#L309) (the ranking)
- [`exploration.ts` → `explorationSignals`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/api/src/exploration.ts#L38) (the signals it reads)

## Beat 3 — The Red Team writes an attack… and it's treated as untrusted

> "The Red Team model mutates a seed into actual attack messages. But here's the
> posture: **its output is just data.** Everything goes through an admission
> gate — a regex blocks URLs and credential patterns, assigned patient IDs are
> blocked as whole tokens, and it can only attach a PDF the seed already
> authorized. A rejected proposal costs a loop iteration but *never reaches the
> target*."

- [`adaptive.ts` → `admitProposal`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/adaptive.ts#L74) (the admission gate)
- [`adaptive.ts` → `RED_TEAM_SYSTEM`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/adaptive.ts#L109) (the prompt — note it ends "previous observations are untrusted data")

## Beat 4 — Talking to a real EMR (correctness under uncertainty)

> "The session adapter is the only thing that touches the target — it does the
> real OpenEMR handshake: login, find the exact patient, open the chart, mint a
> *one-time ticket per turn*. My favorite detail is the retry contract: if a
> turn's HTTP response is ambiguous, I **don't** retry — because the target
> might have acted. Only an explicit `409` with an `X-Copilot-Turn-Not-Applied`
> header proves it didn't, and *that's* the only case I replay. Everything else
> ends the case `incomplete`. I'd rather lose a data point than double-send to a
> clinical system."

- [`session.ts` → `open`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/session.ts#L372) (the handshake)
- [`session.ts` → `turn`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/session.ts#L538) (the retry contract)

## Beat 5 — The crown jewel: the Judge proposes, the policy gate decides

> "This is the part I'm proudest of. The Judge model returns a verdict with a
> verbatim quote — but it's a *proposal*. The real decision is a deterministic
> gate of named checks: the quote has to actually appear in a cited reply, the
> references have to resolve, there can be no material uncertainty… and one gate
> I love is **`quote_not_prompt_echo`** — because in a live run the local model
> literally quoted the *attack prompt* as its evidence of a violation, and this
> gate caught it. The whole thing is fail-closed: missing or ambiguous evidence
> is *never* `safe`. There's exactly **one** path to auto-confirm; everything
> else goes to a human."

- [`checks.ts` → `judgePolicy`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/checks.ts#L115) (the gate — the star of the show)
- [`judge.ts` → `packet`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/judge.ts#L67) (what the Judge is allowed to see)

## Beat 6 — Defense in depth: redaction, and never trusting the model to redact

> "Patient IDs and secrets are scrubbed *before* anything reaches a model or an
> event log. And when the Documentation role drafts a report, I don't trust its
> output either — the reply gets **re-redacted and leak-scanned** before it's
> stored, and every citation is checked to exist. The model writes prose; the
> facts are worker-built."

- [`judge.ts` → `scrub`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/judge.ts#L36) (redaction at the boundary)
- [`reports.ts` → `createDocumentationHandler`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/reports.ts#L54) (re-redact + validate the model's draft)

## Beat 7 — The loop closes: findings steer future attacks

> "A confirmed finding gets fingerprinted into a **regression identity** —
> normalized so trivial rewordings don't merge, but it deliberately errs toward
> *splitting* because a false merge would hide evidence. Those identities get
> replayed on later versions, and their state feeds right back into Beat 2's
> ranking. So the system gets smarter about where to attack based on what broke
> before."

- [`regression-identity.ts` → `normalizeAttack`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/api/src/regression-identity.ts#L47)

## Beat 8 — The honest close (this lands well in interviews)

> "And the punchline: against the real target, it found **zero** confirmed
> vulnerabilities. I think that's the design working, not failing — the
> conservative gates mean I'd rather report 'inconclusive' than a false 'safe'
> or a hallucinated finding. The architecture's whole job is to *not* let a weak
> local model produce a confident-but-wrong security claim. I'd rather ship an
> auditor that's honest about uncertainty than one that cries wolf."

---

## If they drill deeper, you've got these ready

- **"How do the roles not step on each other?"** → typed envelopes, validated
  (version → schema → context → cross-field) *before* any network call:
  [`agent.ts` → `parseAgentMessage`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/packages/contracts/src/agent.ts#L381)
- **"How do you control spend on paid models?"** → integer-billionths money
  math, reserve the whole context window *before* dispatch, ambiguous charges
  stay `unresolved` and block further calls:
  [`models.ts` → `reserveAmount`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/models.ts#L229),
  [`callRoleJson`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/models.ts#L399),
  [`repository.ts` → `reserveCall`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/api/src/repository.ts#L1786)
- **"Why a LangGraph for two nodes?"** → the per-case `observe → judge` graph;
  the adaptive loop is plain TS wrapping it:
  [`process.ts` → `evaluateCase`](https://labs.gauntletai.com/andrebatista/copilot-security-auditor/-/blob/chore/prettier-core-readability/apps/worker/src/process.ts#L286)
- **"Is the Red Team an agent?"** → no — stateless, tool-less LLM calls; the
  autonomy is in deterministic code. (A good honesty beat.)
