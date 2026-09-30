# Animal System Instructions

> **Activation default:** every animal is **always-active by default** — it keeps simulating and never falls through terrain off-screen. Call `controller.setAlwaysActive(false)` ONLY for ambient/background wildlife in large worlds that is safe to freeze off-camera (prefer dynamic toggling). See `@docs spawning-system.md` → "Entity Activation".

## Body plans — pick the right one

| Creature | Plan | How |
|---|---|---|
| Dog, cow, horse, lion… | `quadruped` (auto) | 4 leg arrays |
| Chicken, penguin (walking birds) | `biped` (auto) | back leg arrays only |
| **Fish, shark, dolphin** | `fish` (auto) | NO leg arrays + fins → **swims in 3D inside water** |
| **Octopus, squid, jellyfish** | `cephalopod` (auto) | NO leg arrays + `tentacleBlocks` → **swims with mantle pulses + waving tentacle ring** |
| **Eagle, parrot (flying birds)** | `bird` (**must set `bodyPlan: 'bird'`**) | wings + back legs → **flies in 3D** |
| **Flying dragon, wyvern, griffin** | `dragon` (**must set `bodyPlan: 'dragon'`**) | wings + 4 legs → **flies in 3D** with slow heavy wing beats |
| Ground dragon (wings always folded, never lifts off) | `quadruped` (auto) | 4 legs + wings, NO explicit plan |
| Humans/humanoids | — | NPC System, not animals |
| Snakes | — | Snake system (`createSnake`) |

## 🐷🐮🐴🐕 ANIMALS (4-LEGGED CREATURES)

**4 legs = Animal System, 2 legs = NPC System**

**📖 Full docs:** `game/src/engine/animal/BlockAnimalBodyBuilder.ts`

**✅ Animals auto-update!** Once created with `createAnimal()`, the engine automatically updates them every frame. No manual `update()` calls needed.

### ✨ Auto-Calculated Attachments with Optional Offsets

**Leg, head, and tail attachment points are ALWAYS auto-calculated from body dimensions:**

- **Legs**: 75% inside body in X (25% outside), small Y overlap for smooth animation, slightly inward in Z
- **Head**: Front-top-center of body
- **Tail**: Back-upper-center of body

**You can add OFFSETS to adjust from these defaults** (e.g., crocodile legs more outside, gazelle legs more centered). Offsets are added to the calculated positions.

### ⚠️ CRITICAL: Body must be centered at y=0!

**Body blocks MUST be centered at y=0.** The engine positions the animal based on leg length. If you elevate the body (e.g., `y: 0.8`), the legs will be disconnected!

```typescript
// ✅ CORRECT - body centered at y=0
bodyBlocks: [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.6, height: 0.8, depth: 1.2 }, color: 0x8b4513 },
]

// ❌ WRONG - body elevated, creates gap between body and legs!
bodyBlocks: [
    { position: { x: 0, y: 0.8, z: 0 }, size: { width: 0.6, height: 0.8, depth: 1.2 }, color: 0x8b4513 },
]
```

### 🎨 Encourage Geometric Detail!

Use **multiple blocks** to create:
- Rounded corners (small angled blocks at edges)
- Texture/pattern details (spots, stripes, patches)
- Anatomical features (ribs, spine ridges, muscle definition)
- Fur tufts, manes, feathers
- **Tails!** Don't forget `tailBlocks` - most animals have tails!

**More blocks = more interesting animals!**

### Sample Dog - Use as STRUCTURE REFERENCE only (adjust sizes to real animal proportions!)

```typescript
import { createAnimal, createBlockAnimalFactory, AnimalRoamBehavior, type BlockAnimalBodyConfig } from 'engine/animal/index.js';
import { NpcFollowBehavior } from 'engine/npc/index.js';
import { Spawner } from 'engine/Spawner.js';

// 🐕 DOG - Copy and modify colors/proportions for other animals!
// NOTE: Attachments are auto-calculated! Use offsets only if you need adjustments.
const DOG_CONFIG: BlockAnimalBodyConfig = {
    shoulderHeight: 0.5, // 50cm at shoulder - medium dog (engine auto-scales!)
    
    // BODY - torso with lighter belly (centered at y=0)
    bodyBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.28, height: 0.22, depth: 0.55 }, color: 0xA0522D },
        { position: { x: 0, y: -0.06, z: 0 }, size: { width: 0.24, height: 0.12, depth: 0.45 }, color: 0xD2B48C },
    ],
    
    // HEAD - skull, snout, nose, floppy ears (eyes are automatic!)
    headBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.18, height: 0.16, depth: 0.18 }, color: 0xA0522D },
        { position: { x: 0, y: -0.03, z: 0.11 }, size: { width: 0.1, height: 0.09, depth: 0.1 }, color: 0xCD853F },
        { position: { x: 0, y: -0.06, z: 0.14 }, size: { width: 0.04, height: 0.03, depth: 0.03 }, color: 0x1C1C1C },
        { position: { x: -0.09, y: 0.03, z: -0.02 }, size: { width: 0.06, height: 0.12, depth: 0.05 }, color: 0x8B4513, rotation: { z: 15 } },
        { position: { x: 0.09, y: 0.03, z: -0.02 }, size: { width: 0.06, height: 0.12, depth: 0.05 }, color: 0x8B4513, rotation: { z: -15 } },
    ],
    // headAttachmentOffset - add { x?, y?, z? } to shift from auto-calculated position
    
    // TAIL - multi-segment for natural curve
    tailBlocks: [
        { position: { x: 0, y: 0.04, z: 0 }, size: { width: 0.05, height: 0.05, depth: 0.12 }, color: 0xA0522D },
        { position: { x: 0, y: 0.08, z: 0.1 }, size: { width: 0.04, height: 0.04, depth: 0.1 }, color: 0xA0522D },
    ],
    // tailAttachmentOffset - add { x?, y?, z? } to shift from auto-calculated position
    
    // LEGS with paws - use y to stack segments (x defaults to 0, z for paw forward)
    frontLeftLegBlocks: [
        { position: { y: -0.08 }, size: { width: 0.06, height: 0.16, depth: 0.06 }, color: 0xA0522D },
        { position: { y: -0.18 }, size: { width: 0.055, height: 0.08, depth: 0.055 }, color: 0x8B4513 },
        { position: { y: -0.23, z: 0.01 }, size: { width: 0.06, height: 0.03, depth: 0.07 }, color: 0x654321 },
    ],
    frontRightLegBlocks: [
        { position: { y: -0.08 }, size: { width: 0.06, height: 0.16, depth: 0.06 }, color: 0xA0522D },
        { position: { y: -0.18 }, size: { width: 0.055, height: 0.08, depth: 0.055 }, color: 0x8B4513 },
        { position: { y: -0.23, z: 0.01 }, size: { width: 0.06, height: 0.03, depth: 0.07 }, color: 0x654321 },
    ],
    backLeftLegBlocks: [
        { position: { y: -0.09 }, size: { width: 0.07, height: 0.18, depth: 0.07 }, color: 0xA0522D },
        { position: { y: -0.2 }, size: { width: 0.055, height: 0.08, depth: 0.055 }, color: 0x8B4513 },
        { position: { y: -0.25, z: 0.01 }, size: { width: 0.06, height: 0.03, depth: 0.07 }, color: 0x654321 },
    ],
    backRightLegBlocks: [
        { position: { y: -0.09 }, size: { width: 0.07, height: 0.18, depth: 0.07 }, color: 0xA0522D },
        { position: { y: -0.2 }, size: { width: 0.055, height: 0.08, depth: 0.055 }, color: 0x8B4513 },
        { position: { y: -0.25, z: 0.01 }, size: { width: 0.06, height: 0.03, depth: 0.07 }, color: 0x654321 },
    ],
    // legAttachmentOffsets - add { frontLeft?: {...}, ... } to shift from auto-calculated positions
    
    // OPTIONAL: Add offsets to shift from auto-calculated positions (all values are added to defaults):
    // headAttachmentOffset: { y: 0.05 },  // Move head 5cm higher
    // tailAttachmentOffset: { z: -0.05 }, // Move tail 5cm more back
    // legAttachmentOffsets: { frontLeft: { x: -0.02 }, backLeft: { x: -0.02 } }, // Spread front/back left legs outward
};

// Get valid spawn position (handles terrain height, boundaries, occupation)
const spawner = new Spawner(engine);
const spawnPos = spawner.findValidSpawnPositionNear(spawner.getPlayerSpawnPosition(), {
    minDistance: 5,
    maxDistance: 20,
});

const factory = createBlockAnimalFactory(DOG_CONFIG);
const dog = await createAnimal(scene, physics, engine, spawnPos!, 'Dog', 2.0, factory);

// MUST set behavior!
dog.setBehavior(new AnimalRoamBehavior({ roamRadius: 15 })); // Wanders
// OR: dog.setBehavior(new NpcFollowBehavior({ target: 'player' })); // Follows player
//     (there is no AnimalFollowBehavior — animal behaviours are INpcBehavior,
//      so the NPC behaviours drop straight into setBehavior())
```

### Spawn Positions - Use `findValidSpawnPositionNear()`

**Use the `Spawner` helper for all entity spawning.** It handles terrain height, world boundaries, and occupation checking.

```typescript
import { Spawner } from 'engine/Spawner.js';

const spawner = new Spawner(engine);
const playerSpawn = spawner.getPlayerSpawnPosition();

// Track already-spawned positions to avoid overlap
const alreadySpawned: Array<{x: number, z: number, radius?: number}> = [];

// Spawn multiple animals without overlap
for (let i = 0; i < 5; i++) {
    const spawnPos = spawner.findValidSpawnPositionNear(playerSpawn, {
        minDistance: 5,
        maxDistance: 25,
        occupiedPositions: alreadySpawned,  // Avoid other animals
        // If you have access to environmentObjectSystem:
        // isEnvironmentOccupied: (x, z, r) => this.environmentObjectSystem.isPositionOccupied(x, z, r),
    });
    
    if (spawnPos) {
        alreadySpawned.push({ x: spawnPos.x, z: spawnPos.z, radius: 2 });
        const animal = await createAnimal(scene, physics, engine, spawnPos, 'Dog', 2.0, factory);
    }
}
```

**The helper automatically:**
- Uses proper terrain height (voxel-aware or heightmap)
- Respects world boundaries
- Avoids player spawn point and current position
- Avoids other spawned entities (via `occupiedPositions`)
- Avoids environment objects like trees (via `isEnvironmentOccupied`)
- Avoids tight corners (positions surrounded by walls)

### ⚠️ CRITICAL: Size & Proportions - USE `shoulderHeight` FOR AUTOMATIC SCALING!

**ALWAYS set `shoulderHeight` in your config!** This tells the engine the real-world shoulder height (top of body, not head) and the animal is automatically scaled to that size.

```typescript
const DEER_CONFIG: BlockAnimalBodyConfig = {
    shoulderHeight: 1.0, // 1.0m at the shoulder - engine auto-scales!
    bodyBlocks: [...], // Can use any dimensions - engine scales them
    ...
};
```

**Real-world shoulder heights (use these!):**
- Cat: 0.25m
- Small dog: 0.35m
- Medium dog: 0.5m
- Large dog: 0.7m
- Sheep/goat: 0.7m
- Deer: 1.0m
- Cow: 1.4m
- Horse: 1.6m
- Camel: 1.8m
- Giraffe: 3.0m
- Elephant: 2.5m
- Dragon: 3.5–4m (always imposing — never build a dragon under 3m)

**With `shoulderHeight`, you can copy the sample dog's block structure and just change colors/proportions - the engine will scale it to the correct real size!**

### ⚠️ CRITICAL: Surface markings (spots, patches) must be ON the surface, not inside!

**For spots/patches on body surface:**
- Body width is 0.28 → surface is at x = ±0.14 (half the width)
- Place spot at `x: 0.14` (right side) or `x: -0.14` (left side), NOT `x: 0`
- Make spot thin in the direction it faces the surface

**Dalmatian spots example (on body surface):**
```typescript
bodyBlocks: [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.28, height: 0.22, depth: 0.55 }, color: 0xFFFFFF }, // White body
    // Black spots ON THE SURFACE - x position = half body width!
    { position: { x: 0.14, y: 0.05, z: 0.1 }, size: { width: 0.02, height: 0.06, depth: 0.06 }, color: 0x000000 },  // Right side
    { position: { x: -0.14, y: 0.03, z: -0.05 }, size: { width: 0.02, height: 0.05, depth: 0.05 }, color: 0x000000 }, // Left side
    { position: { x: 0.14, y: -0.02, z: -0.15 }, size: { width: 0.02, height: 0.07, depth: 0.07 }, color: 0x000000 }, // Right side
    { position: { x: 0, y: 0.11, z: 0 }, size: { width: 0.08, height: 0.02, depth: 0.08 }, color: 0x000000 },  // On back (y = half height)
],
```

### ⚠️ CRITICAL: Add markings/patterns (not just solid colors!)

**Zebra** - Stripes wrap AROUND the body (over back and under belly):
```typescript
bodyBlocks: [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.35, height: 0.3, depth: 0.7 }, color: 0xFFFFFF }, // White base
    // Black stripes - height 0.32 (taller than body 0.3) so they wrap over the back!
    { position: { x: 0, y: 0, z: 0.25 }, size: { width: 0.36, height: 0.32, depth: 0.04 }, color: 0x000000 },
    { position: { x: 0, y: 0, z: 0.12 }, size: { width: 0.36, height: 0.32, depth: 0.04 }, color: 0x000000 },
    { position: { x: 0, y: 0, z: -0.01 }, size: { width: 0.36, height: 0.32, depth: 0.04 }, color: 0x000000 },
    { position: { x: 0, y: 0, z: -0.14 }, size: { width: 0.36, height: 0.32, depth: 0.04 }, color: 0x000000 },
    { position: { x: 0, y: 0, z: -0.27 }, size: { width: 0.36, height: 0.32, depth: 0.04 }, color: 0x000000 },
],
```

**Panda** - White body with black patches:
```typescript
bodyBlocks: [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.4, height: 0.35, depth: 0.5 }, color: 0xFFFFFF }, // White body
    // Black shoulder patches
    { position: { x: -0.15, y: 0.1, z: 0.15 }, size: { width: 0.15, height: 0.2, depth: 0.2 }, color: 0x000000 },
    { position: { x: 0.15, y: 0.1, z: 0.15 }, size: { width: 0.15, height: 0.2, depth: 0.2 }, color: 0x000000 },
],
headBlocks: [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.25, height: 0.22, depth: 0.22 }, color: 0xFFFFFF }, // White head
    // Black eye patches
    { position: { x: -0.08, y: 0.02, z: 0.08 }, size: { width: 0.08, height: 0.1, depth: 0.06 }, color: 0x000000 },
    { position: { x: 0.08, y: 0.02, z: 0.08 }, size: { width: 0.08, height: 0.1, depth: 0.06 }, color: 0x000000 },
    // Black ears
    { position: { x: -0.1, y: 0.12, z: -0.02 }, size: { width: 0.08, height: 0.08, depth: 0.06 }, color: 0x000000 },
    { position: { x: 0.1, y: 0.12, z: -0.02 }, size: { width: 0.08, height: 0.08, depth: 0.06 }, color: 0x000000 },
],
// Panda legs are ALL BLACK
frontLeftLegBlocks: [{ position: { x: 0, y: -0.12, z: 0 }, size: { width: 0.1, height: 0.24, depth: 0.1 }, color: 0x000000 }],
```

**Lion** - Add mane around head:
```typescript
headBlocks: [
    { position: { x: 0, y: 0, z: 0 }, size: { width: 0.22, height: 0.2, depth: 0.2 }, color: 0xDAA520 }, // Head
    // Mane - fluffy blocks around head
    { position: { x: 0, y: 0.05, z: -0.1 }, size: { width: 0.35, height: 0.3, depth: 0.15 }, color: 0x8B4513 },
    { position: { x: -0.15, y: 0.05, z: 0 }, size: { width: 0.1, height: 0.28, depth: 0.25 }, color: 0x8B4513 },
    { position: { x: 0.15, y: 0.05, z: 0 }, size: { width: 0.1, height: 0.28, depth: 0.25 }, color: 0x8B4513 },
],
```

### 🎨 VOXEL DETAIL — always add this to NEW animals!

**Add a `detail` block to every new animal config.** The engine then renders each part as voxel art: many small voxels with seeded color variation, rounded silhouettes and optional surface patterns — instead of plain flat boxes. It is generated deterministically from your SAME blocks; **NEVER author voxel-level data by hand** (define shapes with blocks, style with `detail`).

```typescript
const WOLF_CONFIG: BlockAnimalBodyConfig = {
    // ...blocks as usual...
    detail: {
        colorJitter: 0.08,   // 0–1 per-voxel fur/scale noise (default 0.08)
        roundness: 0.45,     // 0–1 silhouette rounding (default 0.4; 0 = hard boxes)
        pattern: { type: 'belly', color: 0xD8D0C8 },  // optional preset
        seed: 7,             // same seed = identical animal every spawn
        // voxelSize: 'auto' (default) — engine derives + budget-clamps it
    },
};
```

**Pattern presets** (computed in part-local space, wrap blocks seamlessly):

| type | Look | Key options |
|---|---|---|
| `'spots'` | round spots (dalmatian, fawn) | `color`, `scale` (spot size, default 0.12) |
| `'stripes'` | bands along the body (tiger, zebra) | `color`, `scale` (stripe width, default 0.1) |
| `'patches'` | chunky two-tone patches (cow) | `color`, `scale` (default 0.18) |
| `'belly'` | lighter underside gradient | `color`; auto-skips legs |
| `'scales'` | brick-banded shading (fish, reptiles) | `color`, `scale` (default 0.06) |

`pattern.parts` limits where it applies: `['body','tail']` etc. (kinds: body/head/tail/leg/wing/fin/tentacle).

```typescript
// Salmon with scale bands:
detail: { roundness: 0.6, pattern: { type: 'scales', color: 0xC96A4A, scale: 0.04, parts: ['body', 'tail'] } }
```

Performance is engine-managed (face budgets + shared geometry across herds) — you never need to think about it. Keep authoring chunky marking blocks too; they survive voxelization as surface recolors.

### 👀 Eye Configuration

**Eyes are automatic** with blinking animation and player tracking. Default is **square voxel-style eyes** with black border.

**Eye options in `BlockAnimalBodyConfig`:**
```typescript
eyes: {
    style: 'square',      // 'square' (default, voxel-style) or 'round' (realistic)
    placement: 'front',   // 'front' (default, predators) or 'side' (prey animals like horses, deer)
    size: 0.04,           // Eye size in meters (auto-calculated if not set)
    color: 0x000000,      // Pupil color (black by default)
    scleraColor: 0xFFFFFF, // White of eye (white by default)
    disabled: true,       // Set to disable eyes completely
    playerTrackingDistance: 5, // Eyes follow player within this distance (meters)
}
```


## 🐟 FISH (swim in 3D inside water volumes)

**A config with NO leg arrays is a fish.** Fish need water — spawn them INSIDE a water volume (the spawn position is used exactly as given, no ground snapping). They swim freely in 3D, bank into turns, pitch when climbing/diving, and never breach the surface. Out of water they sink to the ground and wait.

New part fields (all auto-attached, offsets adjustable like legs/head):
- `leftFinBlocks` / `rightFinBlocks` — pectoral fins at the lower-front body sides. **Define only the left one — the right is auto-mirrored.** Blocks extend outward (−X for left).
- `dorsalFinBlocks` — fin on top of the body (sharks!).
- `tailFinBlocks` — caudal fin, attached to the END of `tailBlocks` so it lags the tail sweep (two-segment whip). Requires `tailBlocks`.
- For fish, head and tail auto-attach at body **mid-height** (body midline), not the top.

```typescript
import { createAnimal, createBlockAnimalFactory, AnimalSwimBehavior, type BlockAnimalBodyConfig } from 'engine/animal/index.js';

const SALMON_CONFIG: BlockAnimalBodyConfig = {
    shoulderHeight: 0.35, // For fish this is the BODY HEIGHT (no shoulders!)
    bodyBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.14, height: 0.3, depth: 0.7 }, color: 0xC0392B },
        { position: { x: 0, y: -0.08, z: 0.1 }, size: { width: 0.13, height: 0.16, depth: 0.45 }, color: 0xE8DAC8 }, // pale belly
    ],
    headBlocks: [
        // Wedge = tapered snout (full height at back, zero at front)
        { position: { x: 0, y: 0, z: 0.08 }, size: { width: 0.12, height: 0.22, depth: 0.18 }, color: 0xA93226, shape: 'wedge', rotation: { x: -8 } },
    ],
    tailBlocks: [
        { position: { x: 0, y: 0, z: -0.1 }, size: { width: 0.08, height: 0.18, depth: 0.22 }, color: 0xA93226 },
    ],
    tailFinBlocks: [
        { position: { x: 0, y: 0, z: -0.06 }, size: { width: 0.03, height: 0.3, depth: 0.14 }, color: 0x922B21 },
    ],
    leftFinBlocks: [ // right fin auto-mirrors this
        { position: { x: -0.08, y: 0, z: 0 }, size: { width: 0.14, height: 0.02, depth: 0.1 }, color: 0x922B21, rotation: { z: 20 } },
    ],
    dorsalFinBlocks: [
        // y:180 flips the wedge so the vertical edge leads and the slope trails — shark-fin profile
        { position: { x: 0, y: 0.08, z: -0.05 }, size: { width: 0.025, height: 0.14, depth: 0.2 }, color: 0x922B21, shape: 'wedge', rotation: { y: 180 } },
    ],
    eyes: { placement: 'side', size: 0.03 },
};

// Spawn INSIDE water (find a water position from your world generation knowledge)
const fish = await createAnimal(scene, physics, engine, new THREE.Vector3(10, waterY - 1, 5), 'Salmon', 3.0, createBlockAnimalFactory(SALMON_CONFIG));
fish.setBehavior(new AnimalSwimBehavior({ roamRadius: 10 })); // 3D water roaming
```

## 🐙 OCTOPUS & SQUID (cephalopods)

**Legless config + `tentacleBlocks` = cephalopod.** Define ONE tentacle shape (blocks hang DOWNWARD, −Y, from the pivot) — the engine instances `tentacleCount` copies (default 8, max 12) in a ring under the body and animates each with a phase-offset travelling wave, a speed-scaled backward trail, and a pulsing mantle (jet-propulsion look). The body tilts into the motion so the tentacles stream behind. Same water rules as fish: spawn INSIDE water, use `AnimalSwimBehavior`.

- `tentacleBlocks` — one tentacle, instanced in a ring. Multi-segment with shrinking widths looks great.
- `tentacleCount` — ring size (octopus 8, jellyfish 6, alien horror 12).
- `longTentacleBlocks` — OPTIONAL squid feeding pair: two extra, longer tentacles at the ring's sides that stream behind instead of waving.
- The body is the mantle — make it tall and rounded for an octopus head-body, long and tapered (wedges!) for a squid.

```typescript
const OCTOPUS_CONFIG: BlockAnimalBodyConfig = {
    shoulderHeight: 0.8, // Body (mantle) height — tentacles add to total height automatically
    bodyBlocks: [ // bulbous mantle
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.5, height: 0.45, depth: 0.5 }, color: 0xB0413E },
        { position: { x: 0, y: 0.28, z: 0 }, size: { width: 0.38, height: 0.14, depth: 0.38 }, color: 0xC75B58 }, // rounded top
    ],
    headBlocks: [], // the mantle IS the head — leave empty, eyes still attach
    tentacleBlocks: [ // ONE tentacle, hanging down; engine makes 8
        { position: { x: 0, y: -0.12, z: 0 }, size: { width: 0.09, height: 0.24, depth: 0.09 }, color: 0xB0413E },
        { position: { x: 0, y: -0.3, z: 0 }, size: { width: 0.07, height: 0.16, depth: 0.07 }, color: 0xC75B58 },
        { position: { x: 0, y: -0.42, z: 0 }, size: { width: 0.05, height: 0.1, depth: 0.05 }, color: 0xD98880 }, // tapering tip
    ],
    eyes: { placement: 'side', size: 0.06, scleraColor: 0xFFF3CD }, // big octopus eyes on the mantle
};

const octopus = await createAnimal(scene, physics, engine, new THREE.Vector3(8, waterY - 2, 4), 'Octopus', 2.5, createBlockAnimalFactory(OCTOPUS_CONFIG));
octopus.setBehavior(new AnimalSwimBehavior({ roamRadius: 8 }));
```

**Squid:** stretch the mantle (e.g. `height: 0.7`, narrower), add a wedge on top as the pointed fin-cap, set `tentacleCount: 8` with SHORT tentacles plus `longTentacleBlocks` for the two feeding tentacles (~2× longer).

## 🦅 BIRDS THAT FLY (3D aerial movement)

**Set `bodyPlan: 'bird'` explicitly** (a winged biped that flies — without it, back-legs-only means a walking biped like a chicken). Flying birds flap with articulated two-segment wings, glide on descents, bank into turns, tuck their legs, and hold an altitude band above the terrain.

Wing fields:
- `leftWingBlocks` — inner wing, pivot at the body's upper side, blocks extend outward (−X for left). **Right wing auto-mirrors.**
- `leftWingOuterBlocks` — optional outer wing segment (wing tip), pivots at the inner wing's outer edge and lags the flap — strongly recommended, it makes the flap look powerful.

```typescript
import { createAnimal, createBlockAnimalFactory, AnimalFlyBehavior, type BlockAnimalBodyConfig } from 'engine/animal/index.js';

const EAGLE_CONFIG: BlockAnimalBodyConfig = {
    bodyPlan: 'bird', // ← REQUIRED for flight
    shoulderHeight: 0.5,
    bodyBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.22, height: 0.22, depth: 0.45 }, color: 0x5D4037 },
    ],
    headBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.16, height: 0.15, depth: 0.16 }, color: 0xF5F5F5 }, // white head
        { position: { x: 0, y: -0.02, z: 0.1 }, size: { width: 0.05, height: 0.05, depth: 0.08 }, color: 0xF39C12, shape: 'wedge' }, // hooked beak
    ],
    tailBlocks: [
        { position: { x: 0, y: 0, z: -0.08 }, size: { width: 0.18, height: 0.03, depth: 0.2 }, color: 0x4E342E },
    ],
    backLeftLegBlocks: [
        { position: { y: -0.06 }, size: { width: 0.04, height: 0.12, depth: 0.04 }, color: 0xF39C12 },
    ],
    backRightLegBlocks: [
        { position: { y: -0.06 }, size: { width: 0.04, height: 0.12, depth: 0.04 }, color: 0xF39C12 },
    ],
    leftWingBlocks: [ // right wing auto-mirrors
        { position: { x: -0.22, y: 0, z: 0 }, size: { width: 0.44, height: 0.04, depth: 0.3 }, color: 0x5D4037 },
    ],
    leftWingOuterBlocks: [ // outer segment lags the flap — the wing-tip whip
        { position: { x: -0.16, y: 0, z: -0.02 }, size: { width: 0.32, height: 0.03, depth: 0.24 }, color: 0x4E342E },
    ],
    eyes: { placement: 'side', size: 0.03 },
};

// Spawn IN THE AIR (e.g. 8m above terrain)
const eagle = await createAnimal(scene, physics, engine, new THREE.Vector3(0, terrainY + 8, 0), 'Eagle', 6.0, createBlockAnimalFactory(EAGLE_CONFIG));
eagle.setBehavior(new AnimalFlyBehavior({ roamRadius: 25, minAltitude: 5, maxAltitude: 14 }));
```

**Ground dragons:** quadruped plan (no `bodyPlan`) + wing parts. The engine holds the wings TUCKED — swept back against the flanks — at every gait, and they never lift off. Use a SLOW `moveSpeed` (2–3): a dragon menaces by mass, not speed.

**Walking birds (chicken, penguin):** keep using the biped plan (back legs only, optional wings, NO `bodyPlan: 'bird'`) — they waddle on the ground and flutter wings when running.

## 🐉 DRAGONS (flying winged quadrupeds)

**Set `bodyPlan: 'dragon'`** for a four-legged flyer: same 3D flight as birds but with slow, heavy wing beats, near-flat soaring, legs trailing beneath (not folded), and the tail doing the steering. All four leg arrays AND wings are required; everything else (horns via wedges, tail spikes, dorsal ridge via `dorsalFinBlocks`) composes like any other animal.

```typescript
const DRAGON_CONFIG: BlockAnimalBodyConfig = {
    bodyPlan: 'dragon', // ← REQUIRED for flight; omit it for a GROUND dragon (wings stay folded on foot)
    shoulderHeight: 3.6, // Dragons are BIG — twice a horse at the shoulder. Don't make timid 1m dragons!
    bodyBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.5, height: 0.5, depth: 1.1 }, color: 0x1B5E20 },
        { position: { x: 0, y: -0.15, z: 0.1 }, size: { width: 0.42, height: 0.25, depth: 0.8 }, color: 0xC8A415 }, // golden underbelly
    ],
    headBlocks: [
        { position: { x: 0, y: 0, z: 0 }, size: { width: 0.3, height: 0.26, depth: 0.35 }, color: 0x1B5E20 },
        { position: { x: 0, y: -0.04, z: 0.25 }, size: { width: 0.2, height: 0.16, depth: 0.25 }, color: 0x2E7D32, shape: 'wedge' }, // tapered snout
        { position: { x: -0.1, y: 0.18, z: -0.08 }, size: { width: 0.05, height: 0.2, depth: 0.05 }, color: 0xECEFF1, rotation: { x: -25, z: 12 } },  // horns
        { position: { x: 0.1, y: 0.18, z: -0.08 }, size: { width: 0.05, height: 0.2, depth: 0.05 }, color: 0xECEFF1, rotation: { x: -25, z: -12 } },
    ],
    tailBlocks: [ // long multi-segment tail — it steers in flight
        { position: { x: 0, y: 0, z: -0.2 }, size: { width: 0.18, height: 0.18, depth: 0.45 }, color: 0x1B5E20 },
        { position: { x: 0, y: 0, z: -0.55 }, size: { width: 0.12, height: 0.12, depth: 0.35 }, color: 0x2E7D32 },
    ],
    tailFinBlocks: [ // arrowhead tail tip
        { position: { x: 0, y: 0, z: -0.08 }, size: { width: 0.04, height: 0.22, depth: 0.18 }, color: 0xC8A415, shape: 'wedge', rotation: { y: 180 } },
    ],
    dorsalFinBlocks: [ // back ridge
        { position: { x: 0, y: 0.08, z: 0 }, size: { width: 0.04, height: 0.16, depth: 0.7 }, color: 0xC8A415 },
    ],
    // Dragon legs are STUBBY — short, thick, powerful (a low-slung bulk, not a leggy horse)
    frontLeftLegBlocks: [{ position: { y: -0.1 }, size: { width: 0.16, height: 0.2, depth: 0.16 }, color: 0x1B5E20 }],
    frontRightLegBlocks: [{ position: { y: -0.1 }, size: { width: 0.16, height: 0.2, depth: 0.16 }, color: 0x1B5E20 }],
    backLeftLegBlocks: [{ position: { y: -0.11 }, size: { width: 0.18, height: 0.22, depth: 0.18 }, color: 0x1B5E20 }],
    backRightLegBlocks: [{ position: { y: -0.11 }, size: { width: 0.18, height: 0.22, depth: 0.18 }, color: 0x1B5E20 }],
    leftWingBlocks: [ // big membranous wings — right auto-mirrors
        { position: { x: -0.45, y: 0, z: 0 }, size: { width: 0.9, height: 0.06, depth: 0.7 }, color: 0x2E7D32 },
    ],
    leftWingOuterBlocks: [
        { position: { x: -0.35, y: 0, z: -0.05 }, size: { width: 0.7, height: 0.05, depth: 0.55 }, color: 0x388E3C, shape: 'wedge' },
    ],
    eyes: { color: 0xFF6F00, size: 0.05 }, // glowing amber
};

const dragon = await createAnimal(scene, physics, engine, new THREE.Vector3(0, terrainY + 12, 0), 'Dragon', 7.0, createBlockAnimalFactory(DRAGON_CONFIG));
dragon.setBehavior(new AnimalFlyBehavior({ roamRadius: 35, minAltitude: 8, maxAltitude: 20 }));
```

## 🔺 WEDGE BLOCKS (tapered shapes)

Any block can set `shape: 'wedge'` — a triangular prism: **full height at the back (−Z), tapering to zero at the front (+Z)**. Use `rotation` to orient. Perfect for snouts, beaks, fin tapers, wing tips, ears. Still reads as voxel — prefer wedges over many stacked thin boxes for tapered details.

```typescript
// Snout pointing forward (tapers toward +Z):
{ position: { x: 0, y: -0.02, z: 0.12 }, size: { width: 0.1, height: 0.08, depth: 0.12 }, color: 0xCD853F, shape: 'wedge' }
// Upright shark dorsal fin (y:180 → vertical leading edge, slope trailing backward):
{ position: { x: 0, y: 0.1, z: 0 }, size: { width: 0.03, height: 0.18, depth: 0.25 }, color: 0x555555, shape: 'wedge', rotation: { y: 180 } }
```

**Custom behavior:** import `NpcFollowBehavior` from `engine/npc/index.js` to use it directly, or copy its source (`engine/npc/behaviors/NpcFollowBehavior.ts`) as a starting point and modify.

## Runtime tuning on a live animal

The handle returned when you spawn an animal exposes the same health and navigation knobs NPCs have.

**Health** — `animal.setMaxHealth(n)` retunes the ceiling (also refills and revives). `animal.heal(amount)` heals up to the max and returns `false` if the animal was already full or is dead — `onDamage` does NOT fire on a heal, so refresh health bars from the return value. `animal.resetHealth()` restores full health and revives.

**Navigation** — all three apply per animal:

```typescript
animal.setArrivalRadius(0.2);        // stop closer to the final destination (default 0.5m)
animal.setAvoidanceEnabled(false);   // stop steering around other agents, and stop being avoided
animal.setStraightLinePath(true);    // skip navmesh A*; you own obstacle routing
```

Read them back with `animal.getArrivalRadius()`, `animal.isAvoidanceEnabled()`, `animal.isStraightLinePath()`, and `animal.getCurrentSpeed()` for the live speed in m/s.

**Route state** — `animal.isFollowingPath()` while it is still walking a route, `animal.hasReachedDestination()` for the inverse. Do NOT test `getPath().length === 0`: arrival advances the waypoint index past the last waypoint instead of clearing the array, so the length only drops to zero once the stuck-detector wipes the path (~2s of standing still) — which looks like a long unexplained pause. Inspect the route with `animal.getPath()`, `animal.getCurrentWaypoint()` and `animal.getCurrentWaypointIndex()`.

**Corpse timing** — `animal.setCorpseLifetimeMs(ms)` controls how long the body lingers after a ragdoll death; `<= 0` keeps it until `dispose()`, and it applies immediately so it also retunes a corpse already down. At spawn that value comes from `damageable.debrisLifetimeMs`, which also drives explosion-debris lifetime — this setter is the only independent control. `animal.hasRagdoll()` reports whether the corpse body is still there; `animal.isRagdolled()` whether the death collapsed into a ragdoll at all — with `ragdollOnDeath` off, `isDead()` is true while `isRagdolled()` stays false.
