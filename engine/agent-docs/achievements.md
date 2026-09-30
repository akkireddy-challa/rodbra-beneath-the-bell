# Achievements & XP (worldProfileData.achievements)

Achievements are per-game goals that award one-time XP to the player who reaches them. XP is
non-monetary progression: it accrues to the player's profile and drives their level. Definitions
live in the game's data; the game code only references them by a stable slug id.

The engine HAS this system — never hand-build an achievement or XP tracker in game code. A
hand-built one earns the player no real XP, never appears on the game page, and never reaches
their profile.

The work splits across two agents:

- **Asset subagent** authors the definitions with `manage-achievements` (below).
- **Coding subagent** only fires `engine.unlockAchievement('<id>')` at the moment the player earns
  one. It does NOT have the `manage-achievements` tool; if a definition it needs does not exist
  yet, say so and let the orchestrator route the authoring to the asset subagent.

## Authoring definitions (asset-side)

Use the `manage-achievements` tool (`list` / `add` / `update` / `remove`) — it writes
`worldProfileData.achievements[]`, each entry `{ achievementId, name, description, imageUrl, xp, hidden }`:

- `achievementId`: stable slug, `/^[a-z0-9_]{1,64}$/`, e.g. `first_win`. This is the id the game
  code passes to `engine.unlockAchievement()`. It never changes once players have unlocked it.
- `name` (1-120 chars), `description` (up to 500 chars).
- `xp`: whole number 1-500 awarded the first time a player unlocks it (default 50).
- `hidden` (default false): hidden achievements are masked in public lists until a player
  unlocks them — use for surprises and secret endings.
- `imageUrl` (auto): a wordless voxel illustration of the accomplishment (themed to the game's
  design doc — never a badge, never with text) is generated for every achievement on `add` and
  rehosted to the game's CDN; on `update` pass `regenerateImage:true` to refresh it. Best-effort —
  stays null when image generation is unavailable (e.g. local dev), which renders a text-only card.

- `enabled` (default true): set false to switch one off without deleting it — it keeps its definition
  and unlock history, goes invisible to players, awards no XP, and frees its share of the XP budget
  for the others.

Limits: up to 50 achievements per game, 500 XP each, and — the one that usually binds — a per-game
**XP budget**: a game's switched-on achievements may grant one player at most 500 XP in total (1000
once the creator's games have been played by 100 different signed-in players).

Going over budget is not an error and never blocks a publish. Every definition saves; at publish the
achievements are walked in order and each one stays live while its XP still fits in what remains, so
the ones that do not fit publish DISABLED (invisible, worth nothing) until the totals come down. The
`manage-achievements` tool names those after every change. Spend the budget deliberately: a handful
of 25-100 XP achievements plus one larger capstone reads better than one that eats the whole budget.

Definitions reach the public game page and the player XP ledger on the next publish; `remove`
soft-removes (players keep XP already earned).

## Awarding from game code

```ts
engine.unlockAchievement('first_win');
```

Fire-and-forget: call it the moment the player earns the goal. The engine dedupes per session
(repeat calls for the same id are ignored), shows a HUD toast, and — when the player is signed in —
posts the unlock so the XP is credited server-side (once). Guests see the toast only; if the player
signs in on the portal during the same play session, unlocks fired earlier in that session are
credited then, but guest unlocks are not persisted across sessions. The id must match an authored
`achievementId`; unknown ids still toast but award nothing.
