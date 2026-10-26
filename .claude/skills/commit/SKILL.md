---
name: commit
description: Create git commits for this repo. Use whenever the user asks to commit, save work to git, or write a commit message.
---

# Commit

Commit the current changes following this repo's conventions. Never commit or
push without the user's explicit approval of the plan in step 5.

## Conventions

- **Branch:** do not create feature branches unless the user asks.
- **Format:** [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): subject`
  - Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`,
    `chore`.
  - Scope is optional and names the area, e.g. `core`, `ui`.
  - Subject: imperative, lowercase, no trailing period, about 50 characters.
  - Subject only; at most one short sentence of body.
- **English only:** message, code, comments, and docs.

## Steps

1. **Inspect.** Run `git status`, `git diff`, `git diff --staged`, and
   `git log --oneline -10`.
2. **Secret check.** Look for anything that must not be committed: `.env*`
   files, private keys (`*.pem`, `*.key`), credential files, and token-like
   strings (`sk-ant-`, `ghp_`, `github_pat_`, bearer tokens, OAuth tokens). If
   anything is found, stop and tell the user. Do not commit it.
3. **English check.** Read the added lines and the planned message. Flag any
   non-English text.
4. **Run checks.** Run `bun run check` (typecheck, lint, format check, mod types check, tests).
   If it fails, show the failure and stop.
5. **Propose a plan.** Group the changes into logical commits, one concern per
   commit. For each commit, list its files and its message. Ask the user to
   approve and wait.
6. **Commit.** For each approved commit, stage only its files by explicit path
   (never `git add -A` or `git add .`), then commit using a heredoc for the
   message.
7. **Report.** Show `git log --oneline` for the new commits. Do not push unless
   the user asks; pushing also needs their approval.
