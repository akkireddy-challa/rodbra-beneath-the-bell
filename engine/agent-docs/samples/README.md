# docs-samples

Runnable reference implementations for the AI agent's docs (`game/agent-docs/`).
Docs reference a sample by path instead of inlining code; the agent reads one via `read-docs(name="samples/<file>")` only when its task warrants.

Rules, both enforced by `pnpm run check`:

- Every sample must type-check against the live engine (`tsc -p tsconfig.docs-samples.json`, run by game's check) — change an engine API and the sample must be updated in the same commit.
- Every sample must be referenced by at least one doc, and every `samples/...` reference in the docs must resolve to a file here (`check-doc-samples.mjs`, run by game-play-agent's check).

Samples import the engine exactly like genre code (`import ... from 'engine/X.js'`) and never import from `work/` or `genres/` — they must stay valid for every game.
