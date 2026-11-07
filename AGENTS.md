# Luckout

Start with `README.md`, `CONTEXT.md` (use its terms), `docs/plan.md`, and `docs/adr/`.

## Working rules

- Don't scaffold, install, or build while we're still discussing; wait for an explicit go.
- Rust contract work happens only when the user explicitly allows it.
- Never commit secrets. Keys live in `.env` files (gitignored) that the user fills in.
- If a change contradicts an ADR, say so instead of silently overriding it.

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-role triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single-context domain documentation layout. See `docs/agents/domain.md`.
