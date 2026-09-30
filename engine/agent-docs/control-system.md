# Control System & Player Actions

> **Coordinate convention:** Movement forward drives the player along the camera's forward direction (camera-local −Z, returned by `ThirdPersonCamera.getForwardVector()`); the player then rotates so its own local **+Z** (gameplay forward) lines up with motion. Mouse-right / right-stick-X **decrements** yaw (turning right is `yaw -= delta` under both conventions). See `@docs coordinate-system.md` §2–§3 before customising movement or camera rotation.

## Cross-Platform Input Architecture

The game uses a unified input system with separate classes for each platform:
- **`DesktopControls`**: Handles keyboard and mouse input (auto-disabled on mobile)
- **`MobileControls`**: Handles touch input with virtual joystick and buttons (auto-disabled on desktop)
- **`GamepadControls`**: Handles physical game controllers (Xbox, PlayStation, etc.) via the Gamepad API
- **`IInputControls`**: Shared interface all classes implement for consistent input polling

All control systems are automatically initialized in `PlayerController` - no manual setup needed.
Gamepad input is OR-merged with keyboard input, so both work simultaneously.

## Default Control Mappings

| Action | Desktop | Mobile | Gamepad (Xbox / PS) |
|--------|---------|--------|---------------------|
| Movement | WASD / Arrow keys | Virtual joystick | Left Stick / D-pad |
| Camera Look | Mouse | Touch (right half) | Right Stick |
| Jump/Ascend | Space | Ascend button | A / Cross |
| Descend/Crouch | Ctrl | Descend button | LB / L1 |
| **Primary Action** | **Enter / Left Click** | Action button | **RT / R2** |
| **Secondary Action** | **Q / Right Click** | Secondary action button | **LT / L2** |
| Interact | E | Interact button (contextual) | X / Square |
| Exit (vehicle/animal) | E | Exit button | B / Circle |

## CRITICAL: Always Use Existing Controls

- **Prefer the 6 built-in actions** (`action`, `secondaryAction`, `interact`, `ascend`, `descend`, `exit`) when the feature fits. Remap their keys instead of inventing new ones.
- **ALWAYS use the Interactable interface** for any new interactive objects (vehicles, doors, collectibles, NPCs)
- **Every keyboard shortcut MUST have a corresponding mobile button.** Desktop and mobile must stay at feature parity — if a desktop player can press R to reload, a mobile player must have a reload button. **No exceptions.** Mouse clicks count as desktop inputs; if left-click shoots on desktop, mobile must have a shoot button (use `setActionHandler('shoot', ...)` which auto-creates it, or `registerCustomAction` if it's a separate action).
- If the 6 built-ins aren't enough, **use `playerController.registerCustomAction()`** (see "Adding Custom Actions" below) — it binds desktop key + mobile button in a single call and is the only safe pattern. Always give it a desktop key: the `desktop` field is optional, but omitting it produces an action desktop players can never trigger (see "Mobile-only actions" below).
- **Do NOT call `desktopControls.registerKeyHandler()` directly.** It creates a desktop-only action; the engine logs a `console.error` on game start when it detects this, and mobile players will be stranded.

## Movement Controls Availability (joystick + jump/crouch)

A **pointer-driven** game — a board game, a city builder, a top-down strategy game played by tapping the scene — has no player for a joystick to drive, and the engine treats that as a declared state rather than a missing feature. It has two shapes, and `bitmagic verify --platform mobile` (and `bitmagic ios build`) recognises both from the running game, treating a phone run with no touch controls as healthy:

- **No player controller at all** — the `no-character` template. Its `Game` builds no PlayerLoader, controller or follow camera, so neither `DesktopControls` nor `MobileControls` exist and scene taps reach your canvas listener untouched.
- **A headless player** — declare `"hasPlayerCharacter": false` in `worldProfileData` (`src/work/world.json`). The engine loads an empty player group and hides the mobile **joystick** and **jump/crouch** buttons; `playerController.getMobileMovementControlsAvailable()` returns `false`, which is what verify reads. Listen for `pointerdown` / `pointerup` on the renderer canvas for scene taps, not `click`: `MobileControls` calls `preventDefault()` on game-surface touches to stop scrolling and zooming, which suppresses the synthesized `click` but never pointer events.

Without either, the engine believes there is a player to move and verify reports the missing joystick as a gap — so declare it rather than tearing the controls down with `mobileControls.forceDisable()`, which removes what verify counts without telling it why.

The auto-detection hides the movement controls when **all** of these hold: `worldProfileData.hasPlayerCharacter === false` **AND** `cameraMode !== 'first-person'` **AND** the player isn't driving a vehicle. So first-person and vehicle games keep their joystick; a headless top-down strategy game does not.

This only affects the joystick + ascend/descend; the action / secondaryAction / interact / exit buttons and any custom buttons are unaffected (they follow their own show/hide logic and parity rules above).

Override the auto-detection when it guesses wrong — `getMobileMovementControlsAvailable()` returns the effective value either way:

```typescript
this.playerController.setMobileMovementControlsAvailable(true);   // force the joystick + jump/crouch on
this.playerController.setMobileMovementControlsAvailable(false);  // force them off
this.playerController.setMobileMovementControlsAvailable(null);   // back to auto-detect (default)
```

Reach `playerController` from a genre via its own reference or `engine.getPlayerController()`.

## Ski movement

`SkiMovement` (engine/ski/) is a pluggable movement system like swimming or vehicles: install it with `playerController.setMovementSystem(...)` or via `worldProfileData.playerMovement = { mode: 'ski' }`. Controls map onto the standard keys (W tuck, S brake, A/D carve, Space jump, action+direction = aerial tricks), so desktop, mobile, and gamepad work without new bindings. Details: read-docs `mechanic-skiing`.

## Customizing Key Mappings

### Desktop (Keyboard)

Remap keys via `DesktopControls` setter methods. This keeps desktop and mobile synchronized (both use the same `actionPressed`, `secondaryActionPressed`, etc. flags).

```typescript
// Example: Use R for reload (as secondary action)
this.desktopControls.setSecondaryActionKeys(['KeyR']);

// Example: Add R as additional action key (alongside Enter)
this.desktopControls.setActionKeys(['Enter', 'KeyR']);

// Available methods:
// setActionKeys(keys)          - Default: ['Enter'] + left mouse click
// setSecondaryActionKeys(keys) - Default: ['KeyQ'] + right mouse click
// setInteractKeys(keys)        - Default: ['KeyE']
// setAscendKeys(keys)          - Default: ['Space']
// setDescendKeys(keys)         - Default: ['ControlLeft', 'ControlRight']
```

### Gamepad (Controllers)

Remap individual gamepad buttons via `GamepadControls` setter methods. Only override the buttons you need — anything not overridden keeps its default mapping.

Access via `this.getGamepadControls()` from any `PlayerController` subclass.

```typescript
const gamepad = this.getGamepadControls();

// Remap individual buttons (standard gamepad button indices).
// set*Button replaces the primary mapping (used for UI labels) and clears aliases.
gamepad.setAscendButton(3);          // Default: 0 (A/Cross)
gamepad.setExitButton(1);            // Default: 1 (B/Circle)
gamepad.setInteractButton(2);        // Default: 2 (X/Square)
gamepad.setActionButton(7);          // Default: 7 (RT/R2)
gamepad.setSecondaryActionButton(6); // Default: 6 (LT/L2)
gamepad.setDescendButton(4);         // Default: 4 (LB/L1)

// add*Button adds an extra button that also triggers the same action.
// The primary button (set above) is used for UI labels; aliases are silent triggers.
gamepad.addActionButton(0);          // A also triggers primary action
gamepad.addSecondaryActionButton(1); // B also triggers secondary action

// Tune analog stick sensitivity:
gamepad.setAxisDeadzone(0.15);       // Per-axis deadzone (default: 0.12)
gamepad.setStickDeadzone(0.08);      // Radial deadzone (default: 0.15)
gamepad.setCameraSensitivity(3.0);   // Right stick camera speed (default: 3.0)

// Steering-only mode: disable left stick Y-axis (forward/backward).
// Useful for racing games where triggers handle acceleration/braking.
gamepad.setMoveYEnabled(false);      // Default: true
```

### Gamepad + Vehicle Driving

When a player enters a vehicle, the engine automatically switches the gamepad to **steering-only mode**:
- Left stick Y-axis is disabled (no forward/backward) — only horizontal steering
- **RT / R2** (action) = accelerate, **LT / L2** (secondaryAction) = brake
- When the player exits the vehicle, normal stick behavior is restored

This means gamepad triggers work for driving out of the box with no template code needed.

### Touch + Vehicle Driving

Touch switches automatically too: in a vehicle, the left joystick becomes a horizontal
**steering slider**, the whole **bottom-right of the screen is a held gas pedal**, and
right-side action buttons re-anchor above the gas zone. There is **no default brake
button on touch** — a game that wants one adds it as an action button (e.g.
`{ action: 'ascend', label: 'Brake', behavior: 'continuous' }`; `ascend` is the engine's
default vehicle brake). Vehicles with a controls extension keep their extension buttons.
No template code needed; everything restores on exit.

For racing games that want face buttons to also drive, add aliases:
```typescript
const gamepad = this.getGamepadControls();
gamepad.setAscendButton(3);              // Y = jump (moved from A)
gamepad.addActionButton(0);              // A also accelerates (alongside RT)
gamepad.addSecondaryActionButton(1);     // B also brakes (alongside LT)
```

**Standard Gamepad Button Indices** (used by setters above):
| Index | Xbox | PlayStation |
|-------|------|-------------|
| 0 | A | Cross |
| 1 | B | Circle |
| 2 | X | Square |
| 3 | Y | Triangle |
| 4 | LB | L1 |
| 5 | RB | R1 |
| 6 | LT | L2 |
| 7 | RT | R2 |
| 8 | Back/View | Share |
| 9 | Start/Menu | Options |
| 10 | Left Stick Press | L3 |
| 11 | Right Stick Press | R3 |
| 12-15 | D-pad Up/Down/Left/Right | D-pad |

### Teleports and held buttons

When you call `playerController.teleportTo(x, y, z)`, the engine automatically clears every in-flight button edge — both the keyboard/mobile `this.keys.{action, secondaryAction, interact, ascend, exit}` flags and the gamepad edge state (via `GamepadControls.consumeCurrentPresses()`). A physical button that is still held down after the teleport will NOT re-fire as a fresh "just pressed" edge; it only fires again on the next genuine release + re-press.

This means templates never need a manual "freeze the held button" helper (e.g. a `freezeGamepadActionButtons` flag) after NPC-triggered teleports, checkpoints, warps, or house-exits. Just call `teleportTo()`.

### Dynamic Input Labels

The engine automatically shows the correct label (keyboard key or gamepad button) based on the player's last active input device. Use `this.getInputLabel(action)` to get the current label:

```typescript
const label = this.getInputLabel('interact'); // Returns "E" or "X" or "Square" etc.
// Valid actions: 'interact', 'action', 'secondaryAction', 'ascend', 'descend', 'exit'
```

Interaction prompts (`showInteractionPrompt`) automatically use dynamic labels — no extra work needed.

## Primary Action System (Enter Key / Left Click)

The engine provides a flexible action system that supports ANY type of player action:
- **Combat Actions**: Melee attacks, projectile shooting, special abilities
- **Non-Combat Actions**: Dancing, crafting, building, emotes, or any custom action
- **Cross-Platform**: Automatically works on desktop (Enter/click) and mobile (action button)

## Secondary Action System (Q Key / Right Click)

For alternate actions like aim-down-sights, block, reload, or alternate fire:
- Use `setSecondaryActionHandler()` to configure, or poll `desktopControls.getKeyStates().secondaryAction` in `update()` for hold-to-activate features like zoom
- Mobile shows a second button left of the action button
- Built-in icon types: 'aim', 'block', 'altfire', 'special', 'reload'

```typescript
// Example: Add aim-down-sights as secondary action
this.setSecondaryActionHandler('aim', (player, controller) => {
    this.toggleAimDownSights();
});
```

## Implementing Custom Actions

Each game genre implements its own action handler using `setActionHandler()`.
See `PlayerController.ts` for implementation details and usage patterns.

## Declaring Mobile Actions Up Front

The recommended way to add custom buttons is to declare them at the genre level via `GenreGameInterface.declareMobileActions()`. The engine calls this after `genreModule.load()` resolves and BEFORE game systems initialize, so every mobile button exists before attack systems, weapon systems, etc. try to reference it. This eliminates lazy-registration bugs where a mobile button briefly didn't exist at the moment a system needed it.

```ts
// In your genre's Game class (implements GenreGameInterface):
import type { MobileActionSpec } from 'engine/MobileActionSpec.js';

declareMobileActions(): MobileActionSpec[] {
    return [
        {
            action: 'shoot',
            desktopKeys: ['KeyF'],
            iconKey: 'shoot',
            label: 'FIRE',
            behavior: 'continuous',
            preferredSlot: 'primary',
        },
        {
            action: 'reload',
            desktopKeys: ['KeyR'],
            iconKey: 'reload',
            label: 'R',
            behavior: 'tap',
            preferredSlot: 'left-1',
        },
    ];
}
```

Each entry is a `MobileActionSpec` (from `engine/MobileActionSpec.js`):

- `action` — unique action name. Becomes the key under `playerController.keys.<action>`.
- `desktopKeys` — key codes, e.g. `'KeyF'`, `'Space'`. **Keyboard only.** `DesktopControls`
  dispatches custom handlers from `keydown`/`keyup` alone, so a mouse pseudo-key like `'Mouse0'`
  registers a binding that never fires — and, because the action does have a mobile button,
  `verifyMobileParity()` reports it as correctly paired. It is inert and looks fine, which is the
  worst combination. Left and right click already drive the BUILT-IN `action` /
  `secondaryAction` flags; to hang behaviour off left click use `setActionHandler(type, handler)`
  (or read `keys.action` each frame), not a custom action.
- `iconKey` — looked up in `MobileIconRegistry`. Built-in keys include:
  `jump`, `crouch`, `interact`, `punch`, `shoot`, `build`, `mine`, `aim`, `exit`,
  `melee`, `projectile`, `dance`, `magic`, `pushup`, `block`, `altfire`, `special`, `reload`.
  Register a custom icon via `MobileIconRegistry.register(key, icon)` where `icon` is `{ kind: 'text', value: 'GO' }` (a short theme-font label, never an emoji) or `{ kind: 'url', value: '/assets/fire.svg' }`. A `url` icon draws the image in place of the text (fitted inside the button, theme color behind it) — on `declareMobileActions` buttons and on the action buttons `setActionType` labels alike.
- `label` — fallback text when icon lookup misses, and the button's accessible name when a `url` icon draws it. Always provide.
- `behavior` — `'tap'` fires once on release; `'continuous'` fires every frame while held.
  The engine owns the release edge for both: a tap key is consumed after the one frame it is
  visible, and a continuous key drops back to `false` when the key or button comes up. On the
  keyboard that release is the keyup handler; a mobile button has no keyup, so the engine tracks
  which continuous actions it raised from a button and lowers them itself on touchend (it leaves
  a key you or the keyboard set alone). Read the state, don't own it: a continuous action you
  latch with `keys.<action> = true` yourself is never released for you.
- `preferredSlot` — layout hint. One of `primary`, `secondary`, `ascend`, `descend`, `left-1`, `left-2`, `left-3`, `top-left`, `top-right`. The `MobileButtonLayout` manager falls back to the next free slot if the preferred one is taken, so declaring several actions with the same preferred slot is safe. **`top-right` is not free on a phone** — see below.
- `initiallyVisible` — optional (defaults to `true`). Some buttons like `exit` are shown only when contextually relevant.

**What the engine does with this:** for each spec, it binds the desktop key(s), creates the mobile button in a non-overlapping slot, and wires both to `playerController.keys.<action>`. Your attack / weapon / whatever system then just reads `this.playerController.keys.shoot` each frame — no need to call `setActionHandler` and no need to worry about mobile creation.

Why use this over `registerCustomAction` (below): it is declarative, runs before game systems initialize, guarantees mobile parity by construction, and uses the `MobileButtonLayout` manager to keep buttons from overlapping. `registerCustomAction` remains available as a lower-level primitive when you need to add a button reactively after load.

### The top-right corner belongs to the pause button

On a touch device the engine puts its own pause button in the top-right corner (`ui/PauseButton.ts`) — the only way a phone reaches the pause card, and with it Resume, the mute toggle and the graphics-quality row. Desktop never shows it; Escape does the same job there. In a pointer-locked game the browser spends that ESC on releasing the cursor, so losing a held lock opens the card itself (`GameRuntimeController.syncPointerLockPause`).

It lives in the HUD layer while action buttons live in the mobile-controls layer, so a game button placed at `top-right` lands *underneath* it. `MobileButtonLayout` therefore treats that slot as taken whenever the pause button is on screen: a spec that prefers `top-right` is moved to the next free slot and a `console.warn` says so. Nothing else changes — you still get eight slots for game actions.

**Hiding it.** A game that opens the pause card from its own UI can take the corner back:

```jsonc
// world.json
"hud": { "pauseButton": "hidden" }
```

That frees the `top-right` slot and removes the engine's button entirely. Only do it if the game gives the player another way in, because there is no gesture fallback:

```ts
import { getGameStateManager } from 'engine/GameStateManager.js';

// From your own menu button / HUD icon:
getGameStateManager().setPaused(true, 'manual');
```

The `'manual'` reason is what makes the engine's pause card appear — other reasons (`'system'`, `'editor-tab'`) pause the simulation without showing it.

**Fading.** The default button starts at full opacity, fades to 30% about four seconds into play, and comes back the moment it is touched. The 44px touch target never changes size, so a dimmed button is exactly as easy to hit as a lit one.

## Adding Custom Actions (Dynamic Buttons)

If you need to add a custom button reactively after load — e.g. the player picks up a grenade and now needs a throw button — use the lower-level **`PlayerController.registerCustomAction()`**. This single call binds both the desktop key(s) AND the mobile button in one atomic operation — keeping feature parity by construction. For up-front per-genre declaration, prefer `declareMobileActions()` above.

### The only approved pattern

```typescript
// In your PlayerController subclass constructor, after super(...):
this.registerCustomAction({
    action: 'reload',
    desktop: { keys: ['KeyR'] },
    mobile: {
        label: 'LOAD',
        behavior: 'tap', // 'tap' fires once per press; 'continuous' fires while held
        // Mobile button colors follow the active UI theme. Optionally pick which
        // theme color paints it via `role`: 'primary' (default) | 'danger' | 'warning'.
        role: 'warning',
        // Optional: draw an image (PNG/SVG/WebP) instead of the label text; the
        // label stays the button's accessible name.
        // imageUrl: '/assets/reload.svg',
        // Optional: stack multiple custom buttons by giving each a unique `bottom`
        position: {
            bottom: 'min(290px, 60vh)', right: '20px',
            width: '70px', height: '70px',
            borderRadius: '50%', fontSize: '14px',
        },
    },
});

// Read state identically for keyboard and mobile:
override update(deltaTime: number): void {
    if (this.keys.reload) {
        this.weapon?.reload();
        this.keys.reload = false; // consume
    }
    super.update(deltaTime);
}
```

The API **throws** if you omit `mobile`. You physically cannot create a desktop-only action through this path.

### Mobile-only actions — allowed, almost never what you want

`desktop` is optional. Omit it (or pass `keys: []`) and you get a **mobile-only** action: the button is created, no key is bound, and the engine logs a `console.warn` instead of throwing. It stopped throwing because one missing key used to abort the entire game load, which is a far worse failure than one degraded button.

Read that warning as a bug report about your own code. On desktop `MobileControls` is disabled entirely, so a mobile-only action is **unreachable** for desktop players — no key, no button, no console error, and `verifyMobileParity()` deliberately stays green. The action simply does nothing, and the creator testing in preview sees a feature that silently isn't there.

So: **always pass a desktop key unless the action is genuinely a touch-only gesture** (swipe, two-finger tap, on-screen drag) that no keyboard can express. "The user asked for a mobile button" is not such a case — give it a key as well. If you find yourself writing `desktop: { keys: [] }`, you almost certainly forgot the key.

### Enforcement: automatic parity check on game start

`GameTemplate` calls `playerController.verifyMobileParity()` on game start. This is an exact per-key check — not a count-based heuristic. It pairs each registered custom desktop key against the mobile action that claims it (via the action → keys map populated by `registerCustomAction` / `declareMobileActions`), and separately pairs each registered mobile action against its desktop keys. A key or action that has no match on the other side is reported individually.

The method returns a `MobileParityResult`:

```ts
interface MobileParityResult {
    ok: boolean;
    unpairedDesktopKeys: string[];   // keys registered on desktop with no mobile button
    unpairedMobileActions: string[]; // mobile buttons with no desktop key
}
```

When `ok` is `false`, the engine logs an error that lists every gap explicitly:

```
[mobile-parity] gaps found. Desktop keys with no mobile button: KeyF(SomeAttackSystem). Mobile actions with no desktop key: (none). Use playerController.registerCustomAction({...}) to bind desktop + mobile together.
```

Each unpaired desktop key is annotated with the `source` string passed when it was registered — so if an attack system called `desktopControls.registerKeyHandler('KeyF', fn, { source: 'SomeAttackSystem' })` without wiring the mobile side, the parity error points you directly at the call site. Keys with no source tag show `(anonymous)`. Keys registered through `registerCustomAction` or `declareMobileActions` are pre-paired and never appear here — only raw `registerKeyHandler` calls ever produce entries in this list.

The creator preview console shows this immediately when testing a game, so broken parity is caught at iteration time rather than by mobile players.

`bitmagic verify` reads this line too, on desktop runs as well as mobile ones: it reports the gaps as a warning, and **fails the run** when `game.json` declares `primaryPlatform: "mobile"` — on a game built for phones, an action a phone cannot reach is a broken game. That makes the line's format a contract with the CLI, not just a message for a human, so do not reword it without updating `cli/src/verify/mobile-parity.ts` alongside.

### When left-click / right-click is your desktop input

Mouse clicks count as desktop inputs. If a gun fires on left click, mobile players need a fire button. Use the built-in action pipeline — it auto-creates the button:

```typescript
this.setActionHandler('shoot', () => { this.gun.fire(); }, { continuous: true });
// That's it. Mobile 'action' button is created automatically with a "FIRE" label (from 'shoot' actionType).
```

No custom registration needed for left-click/right-click actions — `setActionHandler()` and `setSecondaryActionHandler()` already wire the built-in mobile buttons.

### How it works under the hood

- `registerCustomAction()` calls both `desktopControls.registerKeyHandler()` and `mobileControls.registerAction()` internally, and records the full desktop-key list (action name → `string[]` of key codes) in the private `_customActionToKeys` map so `verifyMobileParity()` can do an exact data-driven audit later.
- Desktop key events toggle `this.keys[action] = pressed`. Mobile presses store `pressed: true` in a private `customActions: Map`. Each frame, `applyMobileControlsToKeys()` OR-merges the mobile state into `this.keys[action]` and auto-consumes `tap` actions after one frame.
- The mobile state cannot be externally tampered with: `mobileControls.ascendPressed = false` is a silent no-op (read-only setter), and `customActions` is private with no external write path. Only the engine's reset routines clear state.

### Built-in vs custom actions

|                       | Built-in (ascend, action, …)          | Custom (reload, dodge, …)               |
|-----------------------|----------------------------------------|-----------------------------------------|
| How to add            | `setActionHandler()` (auto-mobile)    | `registerCustomAction()` (explicit mobile) |
| State storage         | Named fields (e.g. `ascendPressed`)    | Private `Map` keyed by action name      |
| Read in game code     | `this.keys.ascend`                     | `this.keys.reload`                      |
| Mobile button created | Yes (6 pre-positioned defaults)        | Yes, by `registerCustomAction`          |
| Parity enforced       | N/A (single API handles both)          | Yes, by `verifyMobileParity()` on start |

### Do NOT

- **Don't** call `desktopControls.registerKeyHandler()` directly. Use `registerCustomAction()` instead. The engine logs a `[mobile-parity]` error on game start if you do.
- **Don't** attach raw `window.addEventListener('mousedown', …)` or `'keydown'` listeners for gameplay actions. Go through `setActionHandler` / `setSecondaryActionHandler` / `registerCustomAction` so mobile parity is automatic.
- **Don't** set `mobileControls.ascendPressed = false` or similar — the setters are read-only no-ops by design. Use `this.keys.<action> = false` in your game code to consume an action.
- **Don't** ship a feature where the desktop player has more capability than the mobile player.
- **Don't** call `registerCustomAction` without a `desktop` key unless the action is a genuine touch-only gesture. It no longer throws, but it strands desktop players silently — the mirror image of the mistake above.

## Controls Architecture

- **Automatically created**: Both `DesktopControls` and `MobileControls` are initialized in `PlayerController`
- **No manual setup needed**: Subclasses can access `this.desktopControls` and `this.mobileControls` (protected properties)
- **No disposal needed**: The base class handles cleanup automatically in its `dispose()` method
- **Auto-syncing**: Calling `setActionHandler()` / `setSecondaryActionHandler()` automatically syncs with mobile controls
- **Custom keys**: Use `desktopControls.registerKeyHandler()` for template-specific keys (e.g., weapon switching)

## Action System Architecture

- The engine's `PlayerController` provides the action framework (key binding, mobile integration)
- Game templates own their specific action implementations (combat systems, dance systems, etc.)
- Templates update their action logic in the constructor via `setActionHandler()`
- The action handler receives the player object and controller for full access to game state
- **Mobile Button Icons**: The mobile action button automatically updates based on action type
  - Built-in defaults: 'melee', 'projectile', 'dance', 'build', 'magic', 'pushup' (rendered as theme-font text labels, never emojis)
  - Unknown types get a generic label
  - Button colors always follow the active UI theme; use `mobileControls.setActionButtonAppearance(label)` to change the action button's text label

## Movement Speed & Acceleration

The default `WalkingAndJumpingMovement` system ramps the player from 0 to `moveSpeed` over ~0.5 seconds. This causes a walk animation to play briefly before the run animation kicks in (since the animation controller uses speed thresholds to pick walk vs run).

To control this behavior, use `setAcceleration()` on the movement system:

```typescript
// Get the movement system (must be WalkingAndJumpingMovement or subclass)
const movement = this.playerController.getMovementSystem() as WalkingAndJumpingMovement;

// Default: moveSpeed * 2 (reaches full speed in ~0.5s, walk animation plays first)
// Set higher to reach run speed faster:
movement.setAcceleration(50);   // Nearly instant

// Set to Infinity to skip walk animation entirely — player runs immediately:
movement.setAcceleration(Infinity);

// Change movement speed (also resets acceleration to speed * 2):
movement.setMoveSpeed(8);
// If you want custom acceleration after setMoveSpeed, call setAcceleration AFTER:
movement.setMoveSpeed(8);
movement.setAcceleration(Infinity);
```

**IMPORTANT:** `setMoveSpeed()` resets `acceleration` to `speed * 2`. Always call `setAcceleration()` AFTER `setMoveSpeed()` if you need a custom acceleration value.

## Pluggable Attack System

- The `IPlayerAttack` interface provides a reusable pattern for combat systems (similar to `IPlayerMovement` for movement)
- Use `setAttackSystem()` to configure attack behavior (melee, projectiles, magic, etc.)
- Attack systems automatically handle input, mobile controls, frame updates, and cleanup
- The base `PlayerController` manages the attack system lifecycle - no manual update or dispose needed

## Action suppression after transitions

When a transition consumes an input press — a teleport, dialogue close, menu dismiss, house entry, conversation end, etc. — the **same physical press** can otherwise leak into the next frame and fire a second subsystem (e.g. a player mapping the same button to "interact with door" and "raise shield" would enter the house AND raise the shield at the same time). Use `PlayerController.suppressActionsFor(seconds, actions?)` instead of hand-rolling per-feature cooldown flags on your subclass.

`teleportTo()` already calls `suppressActionsFor(0.4)` automatically, so any door / portal / checkpoint that teleports the player is covered out of the box. Call it yourself at the end of any other transition where a stale press would cause a double-fire.

```typescript
// End of your dialogue-close handler, menu-dismiss handler, etc.
this.playerController.suppressActionsFor(0.3);

// Or suppress just a specific channel for longer:
this.playerController.suppressActionsFor(0.6, ['action']);
```

While a suppression is active, the engine forces `keys.<action>`, `desktopControls.<action>Pressed`, `mobileControls.<action>Pressed`, and `gamepadControls.<action>Pressed` to `false` every frame, so systems that read any of those channels see a clean `false`. **Do NOT add per-feature cooldown fields to your `PlayerController` subclass** — they drift out of sync the moment a new transition is added.

## When to Use Actions vs Interactions

- **Interactions (E key)**: For objects in the world (doors, vehicles, NPCs, collectibles)
- **Primary Actions (Enter/click)**: For player-initiated abilities (attack, dance, build, special moves)
- **Secondary Actions (Q/right-click)**: For alternate abilities (reload, aim, block, alternate fire)

## Interactable System

For any interactive objects (vehicles, doors, switches, collectibles, NPCs, etc.), implement the `Interactable` interface.

See `interactable.ts` for the interface definition and `ExampleCannon.ts` for a complete reference implementation.

### Why Use the Interactable System

- Automatic cross-platform support (desktop E key + mobile touch buttons)
- Consistent UI/UX with context-sensitive prompts
- No need to manage keyboard bindings or mobile button creation
- Works seamlessly with proximity detection (3.0 unit range)
- Properly integrates with PlayerController state management

### Examples of Interactable Objects

- Vehicles (already implemented) - enter/exit functionality
- Aircraft (airplanes, helicopters, balloons) - enter/land functionality
- Doors, gates, switches - toggle states
- Collectibles (coins, powerups) - onInteractEnd not needed
- NPCs - start dialogue or quests
- Interactive world objects - any object the player can activate

### Adding Your Interactable to the Scene

Set the generic `interactable` property in `userData` on your object's mesh so `PlayerController` can detect it.

## Camera Mode Switching

All game templates have built-in methods for switching between first-person and third-person cameras:

```typescript
game.setCameraMode('first-person');  // or 'third-person'
game.getCameraMode();                // Returns current mode
```
