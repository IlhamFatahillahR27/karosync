# KaroSync Agent Guidelines

## Git Branching Workflow (Mandatory)

- Never commit or push directly to `main`.
- Before making code changes for a new feature or fix, check the current branch (`git branch --show-current`). If currently on `main` (or an unrelated branch), create and switch to a new branch from `main` first:
  - Feature work: `feat/<short-name>` (e.g., `feat/signaling-server`, `feat/client-web`, `feat/extension`, `feat/integration`)
  - Bug fixes: `fix/<short-name>`
  - Documentation / chores: `docs/<short-name>` or `chore/<short-name>`
- Never include phase numbers or the word `phase` in branch names (e.g., use `feat/signaling-server`, not `feat/phase-1-signaling-server`).
- Only commit and push to the active working branch after verification (`npm run typecheck`, `npm run build`, `npm test`) passes, and only push when requested by the user.

## Documentation Maintenance

- Keep the root `README.md` up to date at the end of every phase or significant feature change (monorepo status, setup/dev commands, and protocol/architecture details), and update `docs/roadmap.md` for progress tracking.
- Defer creating the consolidated manual verification guide (e.g., `docs/manual_verification.md`) until the final phase (Integration, Testing & Deployment), once all interconnected components are complete, detailing prerequisites, full end-to-end test scenarios, expected results, edge cases, and a verification checklist.
- Never remove `/docs` from `.gitignore`.
