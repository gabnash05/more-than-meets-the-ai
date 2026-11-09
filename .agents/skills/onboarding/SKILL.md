---
name: onboarding
description: "Use when entering this repo. Trace rules and source."
version: 1.2.0
author: Yashindo, Operator-Syn
license: MIT
platforms: [linux, macos, windows]
---

# Onboarding

Use this skill when entering the repository, resuming after losing context, or starting substantial implementation or review. It refreshes understanding from the current checkout; it is not a substitute for reading task-specific code and tests. Keep the pass proportional to the task.

## Workflow

1. **Inspect the live checkout first.** Run `git status --short --branch` and `git diff --stat`. Note staged, unstaged, and untracked work that could overlap the task. Inspect relevant diffs before editing. Treat existing changes as user-owned; do not reset, discard, stage, or commit them unless explicitly asked.
2. **Read repository instructions and overview.** Read `AGENTS.md`, then `README.md`, `CONTEXT.md`, and `SYSTEM-DESIGN.md`. Use `references/repository-map.md` to find the most relevant task-specific sources; do not load every plan for a narrow task.
3. **Follow the task's source trail.** Read the relevant subsystem README, plan, manifest, implementation, and tests using [the repository map](references/repository-map.md). Route data preparation to its own runbook and CPU-only environment, not automatically to evaluation. Read Guesser-specific instructions and library guidance before model work; trace notebook launchers to the model CLI, and distinguish logged validation comparisons, saved-checkpoint selection, and recognition evaluation. Follow room integration contracts for transport/recovery work and CI documentation plus the actual workflow for automation changes. Before changing scoring or turn lifecycle, read `docs/BACKEND-SCORING-PLAN.md`.
4. **Verify status in the current checkout.** Treat code and tests as evidence of what exists now; treat plans as intended behavior and validation reports as historical claims until checks are rerun. Distinguish implemented behavior from fixtures, planned work, and currently verified results. Do not infer an implementation from architecture diagrams, a passing historical report, or an old conversation.
5. **Resolve conflicting guidance explicitly.** Follow applicable `AGENTS.md` requirements and the latest explicit project decisions. If authoritative sources still disagree or leave a consequential design choice open, identify the exact conflict and ask before making that decision. Do not silently choose based only on file modification time.
6. **Hand off a concise orientation.** State the relevant current behavior and boundaries, the paths that govern the task, any dirty-worktree risk, and unresolved decisions or validation limits. Then proceed with the requested work; onboarding itself does not require a repository change.

## Keep this skill current

Update this skill when the onboarding sequence or repository-wide guidance changes. Update `references/repository-map.md` when project areas, authoritative documents, or task routing change. Do not edit either file for ordinary feature changes; keep volatile implementation status out of this guide and verify it from the checkout instead.

## Pitfalls

- The map indexes entry points and source families, not every source file. Use `search_files` to trace symbols and inspect current tests; never treat the index as exhaustive implementation evidence.
- Include relevant untracked work in the inspection, but label it as local/uncommitted rather than published functionality. Never execute production downloads or notebooks just to onboard.
- Before notebook edits or authorized commits, inspect active jobs and clone-local Git filters/hooks. Preserve execution outputs outside the repository before hooks can strip them; inspect both the staged notebook and working copy afterward. An idle kernel or a completed run does not authorize discarding notebook state.
- Historical diagrams, validation reports, and team-oriented examples do not override the current individual-mode contract.

## Verification

Through `terminal`, run `python .agents/skills/onboarding/scripts/check_repository_map.py` from the repository root after updating this skill or moving entry-point documentation. The stdlib check verifies literal indexed paths and coverage of tracked Markdown docs, model READMEs, and instruction files. It does not validate prose accuracy, links inside other docs, or implementation behavior. Review local untracked additions separately, and run `git diff --check`. No dependency sync or notebook execution is needed for index-only changes.
