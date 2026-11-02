# VS Code Handoff Prompt

```text
Continue work on sollid-web/wolv-stock from the handoff commit eeafaa543d0e672ffd4d7b2883501c5a416355e8.

Safety and scope:
- Preserve all existing and uncommitted work. Never reset, clean, overwrite, or discard files.
- Do not enable signing, create/grant session keys, submit UserOperations, broadcast transactions, or use live trading/provider APIs. The agreed boundary is simulation/readiness only.
- Do not change custody, signer, or execution policy. Stop and ask me before any work that crosses that boundary.
- Do not commit or push unless I explicitly ask.

First validate the handoff before implementing anything:
1. Check `git status`, current branch, and `git log -1`. If there are local changes, preserve them and report what they are; do not pull over or overwrite them.
2. Confirm the repository is on `main` and contains commit `eeafaa5`. If behind, use `git pull --ff-only origin main`; never force-pull or reset.
3. Read `todo-task`, `package.json`, and the relevant code/tests for the recent simulation and proposal-frequency changes. Do not print or expose `.env` values or credentials.
4. Install dependencies with the repository’s package manager and frozen lockfile. Do not modify dependency manifests or the lockfile.
5. Run the focused agent/session-plan/simulation tests, TypeScript, and targeted lint checks. Then run PostgreSQL integration, responsive smoke, and production build if the PC environment supports them. Do not run live-provider or transaction tests.
6. If checks fail, investigate and fix only issues caused by this handoff. Re-run the failing checks. Clearly report any environment-dependent check that cannot run; do not claim it passed.
7. Update `todo-task` with the exact commands and results, including failures or skips.

Only after current changes are verified, continue implementation in the roadmap’s two-phase batches. Read the relevant tests before changing code; implement both phases before running that batch’s tests. Keep all work non-executing and within simulation/readiness. Do not mark a phase complete without evidence. If a phase requires signer/custody choices or live execution authorization, stop at that boundary and document what decision is needed.

At the end, summarize changed files, validation results, remaining blockers, and the current Git status. Do not commit or push.
```
