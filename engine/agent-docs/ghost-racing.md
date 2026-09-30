# Ghost racing (record a run, race the best ones)

Records the player's run, stores it with their time, and replays the best runs
as translucent competitors. Also produces a shareable "challenge a friend" link.

Works for any timed run — racing, time trial, speedrun. Vehicles are the built-in
case; characters use the same machinery with a different channel template.

## Quick start

```typescript
const ghosts = this.engine.getGhostRacing?.();

// Once per level, after the player's vehicle exists.
await ghosts?.attach({
    subject: () => this.playerVehicle,
    input: () => ({ steer: this.steer, throttle: this.throttle, brake: this.brake, buttons: 0 }),
    assetId: this.kartAssetId,         // so the ghost looks like the real kart
    levelId: this.currentTrackId,
    levelName: 'Sunset Ridge',         // shown on the website leaderboard
    opponents: 3,
});

ghosts?.startRun();                     // green light
ghosts?.updateGhosts(deltaTime);        // every frame, seconds
const result = await ghosts?.finishRun({ timeMs: lapMs });
// { rank, total, isPersonalBest, challengeUrl, submitted }
```

`abandonRun()` for a retirement or restart. `detach()` on level switch — the
engine calls it when a new game loads, but a game that switches levels itself
must call it or ghost meshes leak.

## Showing what will race next

```typescript
// After finishRun(), or any time after attach().
for (const ghost of ghosts?.getActiveGhosts() ?? []) {
    // ghost.name, ghost.timeMs, ghost.assetId, ghost.isLocal
}
```

`getActiveGhosts()` is the list to render in a "ghosts for the next run" panel.
`getBoard()` is the leaderboard, and it includes your own record even when the
shared board is empty or unreachable, so a player who has driven the track
always sees their time.

Neither is empty just because the network failed, so check whether the list is
actually empty before reporting "no times recorded". An unreachable leaderboard
is a normal offline state rather than an error worth logging.

## What it does for you

- **Keeps your own best lap on the device.** It becomes a ghost the instant the
  run ends — offline, on a slow connection, or with the server down. The upload
  is what shares it with other players, never what makes it work for you.
- Uploads only personal bests, so the board does not fill with every lap.
- Deduplicates the board to one row per player.
- Spawns, tints, and disposes the ghosts; they have no colliders.
- Resolves the player's display name — profile name when signed in, a generated
  one otherwise. Nothing to ask for and nothing to store.
- Follows a race link on its own: boots the level named by `?track=` and pins
  the run named by `?ghost=` as opponent one.

## Race links (leaderboard rows, "challenge a friend")

A leaderboard row on the website, and the `challengeUrl` from `finishRun()`,
both open the game at `?track=<levelId>&ghost=<entryId>`. The engine honours
both without help — **unless your game shows its own track selector, which will
sit there instead of racing.** Only the game knows it has one, so check:

```typescript
const { trackLevelId, ghostEntryId } = this.engine.getLaunchParams();
if (trackLevelId) this.skipTrackMenuAndStart(trackLevelId);  // ghostEntryId needs nothing
```

Both values are untrusted URL input: an id naming nothing must fall back to
normal behaviour, never to an error.

## Rules

- **Don't ask the player for a name.** The engine resolves it: a signed-in
  player gets their profile name, a guest gets a generated one
  ("TheNeonOtter", "blitz_otter", "V10Cricket90"). A prompt would create a
  second identity alongside the one on their account, and guests already have a
  name worth keeping.
- **Pass `assetId` when the kart comes from an asset** — an asset id or its
  name, whichever the game has. Body shape and wheels are derived from the live
  vehicle automatically, but the vehicle does not know which asset it was
  spawned from. Without it the ghost is a plain box with cylinder wheels
  instead of the actual kart.
  The asset is stored with the run, so a ghost replays in the car that set the
  record rather than whatever you are driving now — and `getActiveGhosts()`
  reports it, for a "set in the Turbo Kart" line. A record whose kart the game
  no longer ships falls back to your vehicle instead of disappearing.
- **`levelId` must be stable per track.** It picks the leaderboard bucket. A
  changed id starts an empty board; there is no cross-level board.
- **Times are milliseconds**, lower is better. Ranking is fixed to ascending.
- **Don't store a run yourself.** Writing replay payloads through
  `GameDataService` directly skips the entry shape and identity stamping the
  facade handles.
- **`updateGhosts()` takes deltaTime in seconds**, like every other engine
  update. The facade keeps its own run clock; do not pass elapsed time.
- **Await `finishRun()` before reading `getActiveGhosts()`.** The new ghost is
  built during that call, so reading beforehand shows the previous state.

## Testing with one player

Production keeps one run per player: uploads are gated on a personal best and
the board dedupes by player. That makes a multi-ghost race impossible to see on
a machine with a single player.

**On localhost this is already the default** — every lap is kept and raced, up
to five per level and up to the `opponents` count. No setup needed.

Elsewhere (except production) add `?ghosts=all` to the game frame's URL.
`?ghosts=best` forces production behaviour back on for a like-for-like check.

## Limits

- Ghosts are visual. They do not collide and cannot be hit.
- A run over 15 minutes is truncated.
- Signed-out players race and appear on boards under a generated name
  ("TheNeonOtter"). They keep it by signing in.

Related: `@docs mechanic-racing.md`, `@docs game-data-service.md`.
