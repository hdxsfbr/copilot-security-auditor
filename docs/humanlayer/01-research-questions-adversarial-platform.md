---
type: research-questions
---

# Research Questions

1. In this repository and its `main` ref, which project materials currently exist, where are the PRD and related documents located, and what do they establish about the Clinical Co-Pilot target, multi-agent roles, evaluation workflow, and required evidence? How does that documented target differ from what is actually present in this checkout? Stay within this project; do not inspect sibling projects.
2. What application code, deployment configuration, target endpoints, test fixtures, credentials configuration, and CI/test infrastructure currently exist in this repository for reaching and testing a live Clinical Co-Pilot? Which target interfaces or prerequisites are specified only in `docs/Week 3_AgentForge_PRD.pdf` rather than implemented here?
3. What current artifacts or schemas, if any, define adversarial cases, OWASP mappings, multi-turn transcripts, judge verdicts, confirmed exploits, regression replays, agent messages/errors, approval boundaries, and coverage/cost traces? How do the PRD and `docs/LECTURE_NOTES.md` describe the relationships among these data and agent roles?
4. According to their current official documentation, what request/response formats, authentication, streaming, model discovery, limits, and usage/cost reporting are available from OpenRouter, Ollama, and Unsloth Studio (called "Unslot Studio" in `task.md`)? What, if anything, in this repository currently uses or configures those interfaces?
5. According to current official Codex CLI and Claude Code documentation, what non-interactive commands, structured output/session behavior, permissions, authentication precedence, and subscription-versus-API billing rules apply? What configuration or integration for either CLI exists in this repository today?
6. What established frontend UI, component library, design tokens, or theming conventions exist in this repository for observing agent activity and security findings? If none exist, which visual surfaces and observability information are described in the PRD, and what colors (including hex codes), typography, spacing, borders, shadows, or theming are actually specified in project materials?

## Key Context Pointers

- Repository: `copilot-security-auditor` (inspect only this project, not other projects in the same parent folder).
- Ticket: `.humanlayer/tasks/multi-model-llm-integration-platform-gv6ruh/task.md`.
- Ticket reference: `documents folder` (not present in this checkout); PRD is available on the repository `main` ref at `docs/Week 3_AgentForge_PRD.pdf`; related materials on `main` include `docs/LECTURE_NOTES.md` and `docs/LECTURE_SLIDES.pdf`.
- Provider and CLI names from ticket: `OpenRouter API keys`, `Ollama`, `Unslot Studio`, `Codex`, `Claude`.
