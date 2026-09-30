# Game Data Service (per-game shared data)

> **For multiplayer game state that should persist across sessions — paint canvases, board positions, shared worlds, anything that all players see and edit together — DO NOT use `GameDataService` directly. Use [`SharedMultiplayerState`](world-persistence.md) instead.** It wraps `GameDataService` with live broadcast, host-driven save, snapshot-on-join, and host migration — all the things you'd otherwise reinvent inline in `Game.ts`. Calling `svc.create()` / `svc.list()` per-edit inside a multiplayer game's `Game.ts` is the anti-pattern; the helper exists so you don't write that code.
>
> Use `GameDataService` directly only for: **leaderboards**, **non-realtime shared data** (custom levels, saved replays a player browses then loads), **submitted-once records** (a user uploaded score, a curated build), or when you're building infrastructure that other game code consumes.

`GameDataService` lets game code store arbitrary JSON **per game** (not per player). It's the underlying server-side storage primitive — Firestore-backed, anonymous session token auth, queryable + opaque-data per entry.

This is **NOT** the same as `GamePersistence` (`@docs persistence-system.md`):

| | `GamePersistence` | `GameDataService` |
|--|--|--|
| Scope | One player on one device | All players of this game |
| Storage | Browser localStorage | Server (Firestore via game-server) |
| Use for | Save slots, checkpoints, settings | Leaderboards, custom builds, submitted records |
| Auth | None | Anonymous session token (auto) + the player credential on board rows |

## Quick Start

```typescript
const dataSvc = this.engine.getGameDataService?.();
// Who this row belongs to. Required on a leaderboard — see "Whose row is it".
const me = await this.engine.getLeaderboardIdentity?.();
if (!dataSvc || !me) return;

// Submit an entry. `data` is opaque storage; `values` is the queryable surface
// (string/number only, max 20 keys). Both bodies are required objects.
const entry = await dataSvc.create('leaderboard', {
  data: { runMeta: {...} },
  values: { score, name: me.displayName },
  playerId: me.playerId,
  verifier: me.verifier,
});

// Read top 10 sorted by score
const result = await dataSvc.list('leaderboard', {
  orderBy: 'values.score',
  orderDir: 'desc',
  limit: 10,
  fields: 'values', // omit `data` payloads to keep responses small
});
```

## Categories

A "category" is a named bucket of entries — `leaderboard`, `custom-levels`, etc. **Categories auto-create on first write** with safe defaults: immutable entries, no secret required, no TTL. The dashboard can change settings later.

Pick lowercase kebab/snake names: `leaderboard`, `weekly-scores`, `user_levels`. Use one category per logical data type — don't mix scores and levels in the same category.

## Whose row is it

**Every leaderboard row carries `playerId` and `verifier` from
`engine.getLeaderboardIdentity()`.** They are what the service verifies before it
stamps the row's owner, and that stamped owner is the only thing the website
reads to say who set a score.

```typescript
const me = await this.engine.getLeaderboardIdentity?.();
// me.playerId    — the account's id, or a generated guest id
// me.verifier    — proves it; goes in the create() call and nowhere else
// me.displayName — the name to show
// me.isGuest     — true when nobody is signed in
```

A row written without the credential has no owner, and the website has nothing
to attribute it to: it renders under a name generated from the entry id, with no
avatar and no profile link, for a signed-in player just the same. The `name` in
`values` does not rescue it — a client can put any string there, so a board will
not show one for a player it cannot verify.

**Take the shown name from `me.displayName`. Never ask the player to type one.**
A signed-in player already chose a name on their profile, and a second one
agrees with nothing — not the board, not their profile, not their other games. A
guest gets a generated name from the same call, so there is no case left that
needs a text field.

`me.isGuest` is there so a game can offer signing in — "sign in to keep this
score" after a good run reads as an offer rather than a wall. Guests still write
rows and still appear on the board.

⚠ `verifier` is a bearer credential. It belongs in the `create()` call and
nowhere else — never in `data` or `values` (reads are public), never on screen.

## Example: leaderboard with rank lookup

```typescript
// In Game.ts of a per-game file:

private async submitScoreAndShowLeaderboard(
    score: number,
    container: HTMLElement,
): Promise<void> {
    const dataSvc = this.engine.getGameDataService?.();
    const me = await this.engine.getLeaderboardIdentity?.();
    if (!dataSvc || !me) {
        container.textContent = 'Leaderboard unavailable.';
        return;
    }

    let myEntryId: string | null = null;
    try {
        const created = await dataSvc.create('leaderboard', {
            data: {},
            values: { score, name: me.displayName },
            playerId: me.playerId,
            verifier: me.verifier,
        });
        myEntryId = created.id;
    } catch (err) {
        console.error('Failed to submit score:', err);
    }

    // Top 10 board
    let topEntries: Array<{ id: string; name: string; score: number }> = [];
    try {
        const result = await dataSvc.list('leaderboard', {
            orderBy: 'values.score',
            orderDir: 'desc',
            limit: 10,
            fields: 'values',
        });
        topEntries = result.entries.map(e => ({
            id: e.id,
            name: String(e.values.name ?? ''),
            score: Number(e.values.score ?? 0),
        }));
    } catch (err) {
        console.error('Failed to load leaderboard:', err);
    }

    // Player's rank, even if they're outside the top 10
    let myRank: { rank: number; total: number } | null = null;
    try {
        myRank = await dataSvc.rank('leaderboard', {
            field: 'values.score',
            value: score,
            direction: 'desc',
        });
    } catch (err) {
        console.error('Failed to compute rank:', err);
    }

    const escape = (s: string): string =>
        s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

    const rows = topEntries.map((e, i) => {
        const isMe = e.id === myEntryId;
        return `<div style="font-weight:${isMe ? 'bold' : 'normal'}">
          ${i + 1}. ${escape(e.name)} — ${e.score}
        </div>`;
    }).join('');

    const rankLine = myRank
        ? `<div style="margin-top:8px">Your rank: #${myRank.rank} of ${myRank.total}</div>`
        : '';

    container.innerHTML = `<div>${rows}</div>${rankLine}`;
}
```

The HUD-side end-of-run dialog should call `submitScoreAndShowLeaderboard(score, area)` once the run ends. See `@docs HUD_ELEMENTS.md` for dialog placement.

## Show the board on the game's public page

**Any game with a leaderboard should declare it.** The website cannot find a
board on its own — it can neither list a game's categories nor guess which way
one sorts — so an undeclared board is invisible there no matter how many rows it
has. One call, right after the board is first written:

```typescript
await this.engine.publishLeaderboard?.({
    category: 'leaderboard',   // where the rows live
    label: 'High scores',      // heading on the page
    metric: 'score',           // 'score' = higher is better; 'time' = lower is better
    field: 'score',            // the key inside `values` holding the number
    levelId: null,             // set when the board belongs to one level
    ghost: false,              // true only for replayable runs (ghost racing)
});
```

Safe to call on every submit — repeats within a session are dropped, and it
never throws.

`field` must name the key the rows actually carry: the service omits rows that
lack the field being sorted on, so a wrong name reads as an empty board.

The creator decides whether it is actually shown (on by default, switchable when
publishing and on the game page). Declaring only says the board exists.

## API Reference

| Method | Purpose |
|--------|---------|
| `create(category, { data, values, playerId?, verifier?, withSecret? })` | Insert a new entry. Returns `{ id, data, values, meta, secret? }`. Server-generated id. `playerId`/`verifier` stamp the row's verified owner — required on a leaderboard. |
| `updateEntry(category, id, { data?, values?, secret? })` | Update an existing entry (only on mutable categories). `secret` required if the category was configured `requireSecret`. |
| `delete(category, id, { secret? })` | Delete an entry (only on mutable categories). `secret` required if the category was configured `requireSecret`. |
| `get(category, id)` | Fetch a single entry. |
| `list(category, { where?, orderBy?, orderDir?, limit?, cursor?, fields? })` | Page through entries. Use `fields: 'values'` to drop the larger `data` payload. |
| `rank(category, { field, value, direction? })` | Returns `{ rank, total }` — useful for "your score is #432 of 18234". |

### `where` filters

```typescript
await dataSvc.list('leaderboard', {
    where: [
        { field: 'values.season', op: 'eq', value: '2026-w17' },
        { field: 'values.score', op: 'gte', value: 1000 },
    ],
    orderBy: 'values.score',
    orderDir: 'desc',
});
```

Supported ops: `eq`, `gt`, `gte`, `lt`, `lte`. Server rejects any combination that requires a composite index that isn't pre-declared — start with simple single-field sorts.

## Mutability and secrets

Auto-created categories are **immutable**: `create` works, `updateEntry` and `delete` return errors. Good for leaderboards (a submitted score shouldn't change).

If the game needs editable entries (custom level editor, build saver):

1. The user's first edit creates the entry — capture the returned `secret` and persist it locally so the same player can edit later:
   ```typescript
   const created = await dataSvc.create('custom-levels', {
     data: levelData,
     values: { name: levelName },
     withSecret: true,
   });
   localStorage.setItem(`level-${created.id}-secret`, created.secret!);
   ```
2. Pass the saved secret on subsequent edits:
   ```typescript
   await dataSvc.updateEntry('custom-levels', id, {
     data: newLevelData,
     secret: localStorage.getItem(`level-${id}-secret`) ?? undefined,
   });
   ```

The category needs `mutable: true` first — auto-created categories are not. Tell the creator to enable it via the dashboard's persistence dialog (or you can adjust this later when admin tooling is available from agent code).

## Limits

- **`data` payload:** max 1 MB (encoded JSON length) — same as Firestore's per-document hard cap. Writes over this return `payload_too_large`.
- **Per-game total storage:** soft quota of 1 MB across all entries in all categories. Shown as a usage bar in the dashboard's persistence dialog so the creator can clean up before things grow unwieldy. Not enforced on writes in v1; treat the bar as a budget hint.
- **`values`:** max 20 keys, key names match `[a-zA-Z][a-zA-Z0-9_]{0,31}`, string values ≤ 256 chars, numbers must be finite.
- **Writes per anonymous session:** 60/min default.
- **Writes per game (all sessions):** 1000/min default.
- **Reads:** no per-call cost surfaced to game code; lightweight to call.

When a write exceeds a limit, the call rejects — wrap submission code in `try/catch` and surface a "try again in a moment" message rather than spinning.

## Important notes

- **A category nobody has written to yet reads as empty, not as an error.** Categories auto-create on the first `create()`, so a brand-new board is the normal state: `list` returns `{ entries: [], nextCursor: null }` and `rank` returns `{ rank: 1, total: 0 }`. Render the empty board; don't treat it as a failure. `get(category, id)` still rejects when the entry isn't there.
- **Don't put secrets, PII, or anything you wouldn't show another player into `data` or `values`.** Anyone can `list` and `get`.
- **Never trust client-submitted scores for high-stakes leaderboards.** v1 has no anti-cheat. Fine for a casual board; not fine for prizes.
- **No real-time updates** — the engine doesn't push notifications. Re-`list` on a timer if a leaderboard needs to refresh during play.
- **Session token is automatic** — never persist it, never expose it to players. The engine fetches and refreshes it transparently.
- **Reads are public, writes are anonymous-authed** — published games work without any login flow. A board row carries the player credential on top of that, which is what makes it attributable; a signed-out player still writes, as a guest.
