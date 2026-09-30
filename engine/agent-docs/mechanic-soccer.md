# Mechanic: soccer

> **Single-player mechanic.** Dynamic prop positions are not network-synced — in multiplayer each client simulates its own ball. Don't combine with multiplayer prompts.

## When to use

Prompts mentioning: kick the ball, soccer, football (round-ball), penalty shootout, free kick, goal scoring, ball physics. Pair with `@docs archetype-soccer.md` for the pitch layout and `@docs animation-assets.md` for the kick clip.

## Camera / perspective

`cameraMode: 'third-person'` on an embodied player who runs up to the ball — required, not just default: `BallSportsSystem` gates the kick on the animated character's foot actually reaching the ball, so there must BE a visible animated character. Never first-person. A fixed whole-pitch view (`'top-down'` + `topDownFitWorld`, `@docs topdown-fit-camera.md`) only for an explicit board-game-style ask ("see the whole pitch", "table soccer") — the kick still works there since the character stays visible.

## Architecture — the kick is an ENGINE system; you write the rules

The kick is provided by the engine's **`BallSportsSystem`** (`engine/BallSportsSystem.js`). Do **not** hand-roll kick physics, contact detection, or the `onImpact` callback — that was the old approach and it kicked the ball even on a clean miss (force applied whenever you were merely *near* the ball). `BallSportsSystem` already does, correctly:

- plays the kick animation (`mSoccerKick01`) and **samples foot↔ball contact every frame across the swing**, applying the impulse the first frame the kicking foot reaches the ball (not the clip's peak-speed frame, which lands ~1 m past the ball),
- **gates the kick on the kicking foot actually reaching the ball** — a swing that misses applies NO force (it reads the foot bone via the engine's `detectLimbContact` primitive, with the gate radius taken from the ball's real physics colliders, not its VXL bounds),
- controlled velocity kick (`setLinvel`, predictable strength) + lift + sidespin, direction player→ball,
- a start-distance precheck, a cooldown, and the mobile action button.

So you only write the **game rules**: goal detection, score, HUD, and ball reset. That lives in a small `SoccerSystem` that owns a `BallSportsSystem` and reads the ball from it.

The ball itself is the asset agent's `soccer_ball` env object (`colliderShape: "sphere"`, placed `dynamic: true`) — see `@docs archetype-soccer.md`. `BallSportsSystem` looks it up by name; if it isn't placed `dynamic`, the kick logs a warning and stays disabled (fix the placement, not the code).

## Files to create

- **`game/src/work/SoccerSystem.ts`** — game rules (goal/score/HUD/reset); owns a `BallSportsSystem`.
- **`game/src/work/Game.ts`** — instantiate `SoccerSystem` after `playerController` and `hud` are ready; call `update(dt)` each frame and `dispose()` on cleanup.

## Wiring the engine kick

```typescript
import { BallSportsSystem } from 'engine/BallSportsSystem.js';

// In SoccerSystem's constructor (after the world is loaded so the ball exists):
this.ballSports = new BallSportsSystem(this.playerController, {
    ballName: 'soccer_ball',   // matches the placed env-object name
    kickSpeed: 11,             // horizontal m/s  (tune for stronger/weaker shots)
    kickLift: 2.8,             // vertical m/s for the arc (~4:1 speed:lift feels natural)
    // kickRange, cooldown, spin, contactSlack, actionName, kickAnimation all have
    // sensible soccer defaults — only override what you need.
});
```

That's the entire kick. The action is bound to the primary action button (Enter / left-click / mobile button) automatically. The engine syncs the ball's rolling mesh every frame, so there is no mesh to update.

## Constants — goal geometry (must match `archetype-soccer.md`)

```typescript
const FIELD_HALF_Z = 25;       // pitch is z ∈ [-25, +25]; goals at z = ±25
const FIELD_HALF_X = 20;       // pitch is x ∈ [-20, +20]
const GOAL_HALF_WIDTH = 3;     // goal mouth is 6 m wide
const GOAL_HEIGHT = 2.75;      // crossbar height
const BALL_RADIUS = 0.4;
const BALL_SPAWN = { x: 0, y: 1.5, z: 0 };
```

## Goal + out-of-bounds + reset (game rules)

Read the ball body from the engine system; reset through it.

```typescript
private checkGoal(): void {
    if (this.goalCooldown > 0) return;
    const ball = this.ballSports.getBallBody();
    if (!ball) return;
    const p = ball.translation();

    if (Math.abs(p.x) <= GOAL_HALF_WIDTH && p.y <= GOAL_HEIGHT + BALL_RADIUS) {
        if (p.z < -FIELD_HALF_Z)      { this.scoreB++; this.onGoal(); }
        else if (p.z > FIELD_HALF_Z)  { this.scoreA++; this.onGoal(); }
    }
    // Ball cleared way off the pitch → bring it back fast. Y < −5 catches falls.
    if (Math.abs(p.x) > FIELD_HALF_X + 8 || Math.abs(p.z) > FIELD_HALF_Z + 8 || p.y < -5) {
        this.ballSports.resetBall(BALL_SPAWN.x, BALL_SPAWN.y, BALL_SPAWN.z);
    }
}

private onGoal(): void {
    this.updateScoreHud();
    this.goalCooldown = 1.5;
    setTimeout(() => this.ballSports.resetBall(BALL_SPAWN.x, BALL_SPAWN.y, BALL_SPAWN.z), 800);
}
```

- Goal-line check uses `GOAL_HEIGHT + BALL_RADIUS` (the ball's real radius), so balls scraping the crossbar count.
- Out-of-bounds margin is tight (**±8 m**), not 60 — a ball in the void should come back fast.
- The goal cooldown stops the ball-in-net oscillation registering multiple goals per shot.

## HUD

```typescript
this.hud.createCustomElement('soccer-score', {
    anchor: 'top-center',
    css: `background: rgba(0,0,0,0.7); color: white; padding: 10px 18px; border-radius: 8px; font-size: 18px; font-weight: bold; border: 2px solid rgba(255,255,255,0.3);`,
    html: `<span id="soccer-score-text">RED 0 — 0 BLUE</span>`,
    onUpdate: (container, value) => {
        const el = container.querySelector('#soccer-score-text');
        if (el && typeof value === 'string') el.textContent = value;
    }
});
this.hud.createCustomElement('soccer-hint', {
    anchor: 'bottom-center',
    css: `background: rgba(0,0,0,0.6); color: white; padding: 6px 12px; border-radius: 6px; font-size: 13px;`,
    html: `<span>Press the action button to kick the ball</span>`
});

// Update on every goal:
this.hud.updateCustomElement('soccer-score', `RED ${this.scoreA} — ${this.scoreB} BLUE`);
```

Use one combined scoreboard, not two `createCounter`s.

## update / dispose

```typescript
update(deltaTime: number): void {
    this.ballSports.update(deltaTime);          // engine kick cooldown
    if (this.goalCooldown > 0) this.goalCooldown -= deltaTime;
    this.checkGoal();
}

dispose(): void {
    this.ballSports.dispose();
}
```

## Wiring into Game.ts

```typescript
// In load(), after playerController + hud are ready:
this.soccerSystem = new SoccerSystem(this.engine, this.playerController, this.hud);

// In update():  this.soccerSystem?.update(deltaTime);
// In dispose(): this.soccerSystem?.dispose();
```

## Tweaks for variants

- **Penalty shootout**: spawn the ball at a penalty spot `(0, ±19)`; optionally widen `kickRange` so the player can always reach it.
- **Stronger / weaker shots**: pass `kickSpeed` / `kickLift` to `BallSportsSystem`. Keep roughly 4:1 horizontal:vertical for a natural arc.
- **Bigger goals**: bump `GOAL_HALF_WIDTH` / `GOAL_HEIGHT` and update the visual posts in `archetype-soccer.md` to match.
- **AI opponents (later)**: load `@docs npc-system.md`. Each NPC can own its own `BallSportsSystem` (different `actionName`) and trigger a kick when near the ball.

## Common gotchas

- **Don't hand-roll the kick.** Use `BallSportsSystem`. The old manual `tryKick` + `onImpact` recipe applied force on a near-miss; the engine system gates on real foot contact.
- **Place the ball `dynamic`.** A non-dynamic `soccer_ball` is batched static, has no rigid body, and the kick disables itself. Place it with `--dynamic`.
- **Spawning the ball above the pitch is fine.** A dynamic env prop is placed with its body asleep, and Rapier does not apply gravity to a sleeping body — but `BallSportsSystem` wakes the ball on construction, so a `y: 1.5` spawn drops onto the pitch instead of hanging in mid-air. Don't "fix" a floating ball by moving the spawn to ground level.
- **Don't make goals physical.** They must let the ball through — detection is coordinate-only.
- **Goal cooldown matters.** Without it the ball-in-net oscillation registers multiple goals per shot.
