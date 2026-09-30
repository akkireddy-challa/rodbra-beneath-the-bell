# Doors & Locks

Sliding doors and keycard readers are first-class engine primitives — **never hand-roll a per-door constants block, marker math, or a custom lock state machine**. Use `Door` and `KeycardReader` from `engine/Door.js` / `engine/KeycardReader.js`.

## Minimal example

```typescript
import * as THREE from 'three';
import { Door, DEFAULT_DOOR_OPTIONS } from 'engine/Door.js';
import { KeycardReader, DEFAULT_KEYCARD_READER_OPTIONS } from 'engine/KeycardReader.js';

const door = new Door(this.engine, {
    ...DEFAULT_DOOR_OPTIONS,
    position: new THREE.Vector3(8, 3, -12),
    requiresKeycardId: 'red-keycard',
});

new KeycardReader(this.engine, {
    ...DEFAULT_KEYCARD_READER_OPTIONS,
    position: new THREE.Vector3(9.5, 3, -12),
    keycardId: 'red-keycard',
    getPlayerCarriedItemId: () => this.getCarriedKeycardId(),
    onUnlock: () => door.setLocked(false),
});
```

That's the whole pattern. The engine wires the kinematic body, collider, mesh, slide animation, and E-key prompt automatically.

## `Door` options

| Option | Default | Purpose |
|--------|---------|---------|
| `position` | required | World-space center when closed. |
| `rotation` | `0` | Yaw radians around Y. See `coordinate-system.md`. |
| `width` / `height` / `thickness` | `2 / 3 / 0.2` | Door dimensions in meters (door-local X / Y / Z). |
| `slideDistance` | `2` | Meters the door travels when fully open. |
| `slideAxis` | `'x'` | Door-local axis it slides along. `'x'` for sideways, `'y'` for upward, `'z'` for forward. |
| `slideDurationMs` | `800` | Time for a full open or close. |
| `requiresKeycardId` | `null` | If set, the door starts locked. `setLocked(false)` (or a `KeycardReader.onUnlock`) unlocks it. |
| `onOpen` / `onClose` | `null` | Fire-and-forget callbacks at the moment animation starts. |

Public API: `open()`, `close()`, `toggle()`, `isOpen()`, `setLocked(locked)`, `isLocked()`, `getRequiredKeycardId()`, `dispose()`. The E-key calls `toggle()` automatically (no-op when locked — the prompt shows `[E] locked`). `getRequiredKeycardId()` returns whatever `requiresKeycardId` was set to at construction — use it to verify the paired `KeycardReader.keycardId` matches.

## `KeycardReader` options

| Option | Default | Purpose |
|--------|---------|---------|
| `position` | required | World-space center of the reader panel. |
| `rotation` | `0` | Yaw radians around Y. Match the door's rotation so the panel faces the same way. |
| `keycardId` | required | Must equal what `getPlayerCarriedItemId()` returns to unlock. |
| `getPlayerCarriedItemId` | required | Callback returning the id of whatever the player is currently carrying, or `null`. Use this to plug into the carry system your template already has (e.g., look up the `displayName` of the active `CarryableComponent`). |
| `onUnlock` | `null` | Typically `() => door.setLocked(false)`. |
| `onWrongCard` | `null` | Use for trap doors or "wrong card" cues. |

## Prompt feedback

Both primitives surface contextual hints in the interaction prompt — the template author does NOT need to wire up any HUD or toast logic:

- Locked `Door` (player carries nothing or wrong card): prompt shows **`Locked`** without the `[E]` glyph — pressing E is a no-op so the engine omits the action hint.
- Unlocked `Door`: prompt shows `[E] Open door` / `[E] Close door`.
- `KeycardReader` while the player carries the matching `keycardId`: `[E] Use keycard reader`.
- `KeycardReader` while the player carries something else: `Wrong keycard` (no `[E]` glyph unless `onWrongCard` is set — then E fires the trap callback).
- `KeycardReader` while the player carries nothing: `Needs a keycard` (no `[E]` glyph unless `onWrongCard` is set).

## Positioning & rotation

`rotation` is yaw radians around Y, following the engine's gameplay convention (+Z forward). At `rotation: 0` the door's wide face spans the world X axis and slides along it. At `rotation: Math.PI / 2` it spans world Z and slides along Z. For doors aligned to world axes, use `0`, `Math.PI / 2`, `Math.PI`, or `-Math.PI / 2`. See `coordinate-system.md` for the full convention.

Put the keycard reader **next to** the door, not on it — the reader has its own E-key sensor and the player needs to walk up to it.

## Removing a door

Call `door.dispose()`. The reader is independent — call `reader.dispose()` separately if you also want it gone.

## Dungeon door system (data-driven)

For dungeons and forged levels, doors and keys are **data**, not code: `worldProfileData.doors[]` and `worldProfileData.keyItems[]`. The engine builds a kinematic door with an animated leaf, proximity auto-open, locking, key-unlock prompt, and navmesh blocking for every entry — and a collectible for every key — with no game code at all. Multiplayer sync and level filtering come for free.

### `doors[]`

| Field | Default | Purpose |
|-------|---------|---------|
| `id` | required | Unique within the world. The handle for the runtime API below. |
| `position` | required | World-space centre when closed. |
| `rotationY` | required | Yaw radians around Y (gameplay convention, see `coordinate-system.md`). |
| `width` / `height` / `thickness` | required | Door-local X / Y / Z in meters. |
| `kind` | required | `'plain'` auto-opens for anyone. `'locked'` stays shut and blocks pathing until unlocked. |
| `keyId` | — | Key that unlocks a `'locked'` door. Matches a `keyItems[].keyId`. |
| `animation` | required | `'hinge'` (swings), `'slide'` (into the frame), `'dissolve'` (shrinks away). |
| `assetId` | — | VXL/GLB leaf asset, scaled to the door's dimensions. Absent = engine box mesh. |
| `color` | `#6a4a2a` | Box-mesh tint when `assetId` is absent. |
| `autoOpenRadius` | `2.5` | Meters at which an unlocked door opens for the player or an NPC. |
| `levelId` | — | Level this door belongs to. Omitted = present in every level. |

### `keyItems[]`

| Field | Default | Purpose |
|-------|---------|---------|
| `id` | required | Unique within the world. |
| `keyId` | required | Granted on collection; unlocks every door requiring it. |
| `name` | required | Shown in the pickup toast. |
| `position` | required | World-space position of the collectible. |
| `assetId` | — | VXL/GLB pickup visual. Absent = engine box mesh. |
| `color` | `#d4b64a` | Box-mesh tint when `assetId` is absent. |
| `levelId` | — | Level this pickup belongs to. Omitted = present in every level. |

A key already collected this session is not re-spawned when the player re-enters its level.

### Runtime API

`engine.getDoorSystem?.()` returns the system (null when the world declares no doors or keys). Only **scripted** gates need it — proximity opening and key unlocking already work on their own.

- `openDoor(id)` / `closeDoor(id)` — force a door, ignoring its lock. Returns false for an unknown id.
- `lockDoor(id)` / `unlockDoor(id)` — set the lock without needing the key.
- `getDoorState(id)` — `'closed' | 'opening' | 'open' | 'closing'`, or null.
- `getKeyring()` — `has(keyId)` / `keys()` for what the player carries.

### Multiplayer

Door state and collected keys sync automatically across the room, and are **live-session only** — they never persist across sessions, so every session starts the dungeon unsolved.

Lock state does **not** propagate: `lockDoor`/`unlockDoor`, and the engine's own "press E with the key" unlock, apply to one client. Drive co-op gates from symmetric game logic that runs on every client (boss defeated, puzzle solved), not from one player's unlock.

### Boss-gate example

```typescript
const doors = this.engine.getDoorSystem?.();
doors?.lockDoor('boss_exit');            // seal the arena when the fight starts
// ...on victory:
doors?.unlockDoor('boss_exit');          // the player can walk out
```
