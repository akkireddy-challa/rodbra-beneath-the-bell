# Player Visibility — hiding, showing, and disabling the player

Visibility and physics-enable are **two orthogonal concerns** in the engine:

| Concern | Lives on | Methods |
|---|---|---|
| **Visibility** — is the character rendered? | `engine.getPlayerVisibility()` | `hide()`, `show()`, `setManualOverride()`, `setHideReason()`, `setHiddenBodyParts()` |
| **Physics + update loop** — is the capsule simulating, is the controller running? | `playerController` | `setPlayerEnabled(boolean)`, `isPlayerEnabled()` |

Compose them for the four states you might want:

| State | Visibility | Physics | How |
|---|---|---|---|
| Normal gameplay | visible | running | (default) |
| Stealth / ghost mode | hidden | running | `vis.hide()` |
| Cutscene pose (frozen, on-screen) | visible | frozen | `playerController.setPlayerEnabled(false)` |
| Fully disabled (board games, strategy) | hidden | frozen | `vis.hide()` **and** `playerController.setPlayerEnabled(false)` |

## The anti-pattern

```ts
// ❌ DO NOT — fights with first-person camera, vehicle/aircraft mounts, and
// the "hidden during MENU" lifecycle rule. Whoever writes last wins.
this.player.visible = false;
```

## Visibility — the runtime API

```ts
const vis = this.engine.getPlayerVisibility();

vis.hide();              // hide at runtime — composes with other reasons
vis.show();              // undo the hide()
vis.isManuallyHidden();  // true iff hide() is currently in effect
```

`hide()` / `show()` are idempotent and compose with every other reason the
character might be hidden — first-person camera, aircraft mode, etc. So
calling `show()` while the camera is first-person does NOT reveal the
character; the first-person hide stays in effect. That's correct.

**Heads-up on the query methods:**

- `vis.isManuallyHidden()` only reports whether `hide()` is in effect — it is
  **not** the same as "the character is currently invisible to the user".
  Other reasons (first-person mode, etc.) can hide the character without
  `hide()` being called.
- `vis.isVisible()` reports whether the character **root** is rendering. It
  ignores body-part filters (a hands-only first-person config can have the
  root visible but every body part hidden).
- For "is anything actually rendering?" you usually want `!vis.isVisible()`
  *plus* knowledge of your own filter state. Don't expect a single boolean.

## Physics + update — the enable API

```ts
this.playerController.setPlayerEnabled(false);  // freeze capsule, skip update loop
this.playerController.setPlayerEnabled(true);   // resume
this.playerController.isPlayerEnabled();        // current state
```

`setPlayerEnabled(false)` disables gravity, collisions, and player input —
the character pose freezes in place. The visible mesh stays where it was
unless you also call `vis.hide()`.

## Picking what to use

| You want | Use |
|---|---|
| **Blink, flash, dodge-iframes** | `vis.hide()` / `vis.show()` |
| **Hide during cutscene** (just visibility) | `vis.hide()` |
| **Freeze player but keep them on-screen for cutscene** | `playerController.setPlayerEnabled(false)` |
| **Fully disable for board game / strategy** | `vis.hide()` + `playerController.setPlayerEnabled(false)` — **better:** set `"hasPlayerCharacter": false` in `world.json` and skip the whole player |
| **No player character at all** | `"hasPlayerCharacter": false` in `world.json` |
| **First-person mode hides body** | Already handled by `CameraManager` — don't touch |
| **Hide only specific body parts** (e.g. hands-only first-person) | `vis.setHiddenBodyParts('my-reason', ['head','torso',...])` |
| **Force visible regardless of any other reason** (rare) | `vis.setManualOverride(true)`. Clear with `setManualOverride(null)`. |

## Worked example — blinking i-frames after damage

```ts
private invulnTime = 0;

onDamage(): void {
    this.invulnTime = 1.5; // 1.5s of invuln
}

update(deltaTime: number): void {
    const vis = this.engine.getPlayerVisibility();
    if (this.invulnTime > 0) {
        this.invulnTime -= deltaTime;
        // 8 Hz blink
        const shouldHide = Math.floor(this.invulnTime * 8) % 2 === 0;
        if (shouldHide && !vis.isManuallyHidden()) vis.hide();
        else if (!shouldHide && vis.isManuallyHidden()) vis.show();
    } else if (vis.isManuallyHidden()) {
        vis.show();
    }
}
```

## Worked example — hide during cutscene

```ts
startCutscene(): void {
    this.engine.getPlayerVisibility().hide();
    this.playerController.setPlayerEnabled(false); // also freeze input/physics
}

endCutscene(): void {
    this.engine.getPlayerVisibility().show();
    this.playerController.setPlayerEnabled(true);
}
```

## When the engine controls visibility for you

You usually do NOT need to touch `PlayerVisibility` at all, because the
engine already handles:

- **First-person camera** — body hidden automatically via `CameraManager`.
  Anything attached to the body (a hand-held sword) hides with it — melee in
  first person goes through `FirstPersonMeleeSystem` (camera view model), not
  body attachments.
- **Pre-PLAYING (MENU / READY / LOADING)** — character hidden until Play.
- **Objects parented to the player group** — a ranged weapon (guns are parented
  to the group, not to a hand: the arms are posed onto the weapon's grips) and
  anything a template adds with `player.add(...)` follow the character's
  visibility. Both roots — the block character AND the player group — are
  toggled together, so an equipped gun renders whenever the body does. Note the
  visible body itself is `BlockCharacterRenderer`'s own root, a scene-level
  sibling; the player group holds the animation rig (hidden) plus attachments.
- **`hasPlayerCharacter: false`** — no character loaded; nothing to hide.
  Also NO animation controller: animation-driven systems (`WeaponMeleeSystem`
  swings) cannot run — use `FirstPersonMeleeSystem` for melee on headless
  players (see `@docs mechanic-combat.md`).
- **Vehicle / aircraft mounts** — handled by the respective controllers.

Reach for these APIs only when YOUR gameplay needs visibility / physics
toggling (i-frames, cutscene, stealth, ghosting, teleport flash, etc.).

## Composable visibility API (advanced)

For independent gameplay sources that each want the player hidden (e.g. a
stealth ability AND a dodge roll, both active, character hidden until BOTH
clear), use named reasons:

```ts
vis.setHideReason('stealth-ability', true);
vis.setHideReason('dodge-roll', true);
vis.setHideReason('stealth-ability', false); // still hidden
vis.setHideReason('dodge-roll', false);      // now visible
```

Use named reasons whenever you have multiple overlapping sources — they
compose by union; the character is visible iff every reason is cleared.

`setManualOverride(true | false | null)` is the force-override channel —
bypasses every reason. Rarely needed; use `hide()` / `show()` for the
normal case, and only reach for `setManualOverride` when you genuinely
need to win against engine-managed reasons like first-person mode.
