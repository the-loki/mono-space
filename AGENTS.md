## Agent skills

### Issue tracker

Issues and specs live as GitHub issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, each string equal to its role name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Communication

Chat replies use Chinese (简体中文).

### Ponytail

All coding tasks load the `ponytail` skill.

### TDD

All coding tasks follow TDD.

## Code style

- Keep files focused on a cohesive responsibility and functions on a single task. When extending a large file or function, extract separable responsibilities before adding more logic.
- Split along domain, I/O, data transformation, or view boundaries. Give extracted modules explicit inputs and outputs; keep coupled state transitions under one owner and dependencies acyclic.
- Use line count as a review signal, not a quota. Each extraction must improve readability or testability. Explain in the change summary why a large touched file or function remains cohesive when retaining it.
- Preserve public interfaces, persisted formats, side-effect ordering, and error/cancellation behavior during refactors; verify through public-interface behavior tests.
