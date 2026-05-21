# Claude Code instructions

Agent rules and project context for this repository. `AGENTS.md` is the
tool-agnostic source of truth; this file pulls it in so Claude Code auto-loads
it on every session.

@AGENTS.md

## Auto-loaded context

Read these before implementing or making architectural decisions:

@context/project-overview.md
@context/architecture-context.md
@context/code-standards.md
@context/ai-workflow-rules.md
@context/progress-tracker.md

Update `context/progress-tracker.md` after each meaningful implementation
change. If implementation alters architecture, scope, or standards, update the
relevant context file before continuing.
