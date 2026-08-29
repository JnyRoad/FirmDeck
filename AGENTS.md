# StaffDeck Agent Rule Router

This file only routes project rules. Do not preload rule files; read only the
files selected below for the current task. When a task spans multiple scopes,
load every matching file.

| Task scope | Read |
|---|---|
| Read, change, test, or debug backend code | `agent-rules/context.md` + `agent-rules/backend.md` |
| Read, change, test, or debug frontend code | `agent-rules/context.md` + `agent-rules/frontend.md` |
| Change UI copy, localization, or locale behavior | `agent-rules/i18n.md` (and `frontend.md` when frontend code changes) |
| Run the local application | `agent-rules/local-runtime.md` |
| Change configuration, credentials, or security-sensitive behavior | `agent-rules/security.md` |
| Write or reorganize project documentation | `agent-rules/documentation.md` |
| Create or manage issues | `agent-rules/issues.md` |
| Commit, push, create, or review a pull request | `agent-rules/git.md` |
| Prepare a versioned release or change the app version | `agent-rules/release.md` |

If no route matches, no project-specific rule needs loading. Re-read a selected
rule only if the task changes or the conversation context no longer contains it.
