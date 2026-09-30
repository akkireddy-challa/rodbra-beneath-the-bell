# Snake System Instructions

## 🐍 SNAKES (LEGLESS SERPENTINE CREATURES)

**No legs = Snake System, 4 legs = Animal System, 2 legs = NPC System**

**📖 Full docs:** `game/src/engine/animal/SnakeBodyBuilder.ts`, `game/src/engine/animal/SnakeController.ts`

**✅ Snakes use the same behavior system as animals!** Use `AnimalRoamBehavior`, `AnimalSwimBehavior`, `AnimalFlyBehavior`, or any `INpcBehavior` (e.g. `NpcFollowBehavior`).

### How Snakes Work

Snakes are built from a chain of voxel-block **segments** that undulate with a sine wave. The system creates:
- **Head** — wider/flatter than body, with slit-pupil eyes and a forked tongue that flicks periodically
- **Body segments** — N segments (6–30) that taper from head to tail, with optional colour patterns
- **Tail** — a thin, tapered final segment

Animation uses **lateral undulation**: a sine wave propagates from head to tail, and each segment trails behind the one ahead during turns, creating realistic serpentine movement.

### SnakeConfig Interface

```typescript
import { createSnake, type SnakeConfig } from 'engine/animal/index.js';

const config: SnakeConfig = {
    segmentCount: 12,          // Body segments (6–30, default 12)
    headColor: 0x336633,       // Head colour (hex)
    bodyColor: 0x225522,       // Primary body colour (hex)
    bellyColor: 0x88AA88,      // Optional underside colour
    patternColor: 0x448844,    // Optional accent colour (requires patternType)
    patternType: 'diamonds',   // 'none' | 'stripes' | 'diamonds' | 'zigzag'
    bodyThickness: 0.1,        // Cross-section thickness in metres (default 0.1)
    totalLength: 1.5,          // Nose-to-tail length in metres (default 1.5)
    scale: 1.0,                // Uniform scale multiplier (default 1.0)
    moveSpeed: 2.0,            // Movement speed m/s (default 2.0)
    // headSize: { width, height, depth },  // Override head dimensions
    // eyes: { style, placement, color, scleraColor, disabled, ... }
};
```

### Complete Example — Spawning a Snake

```typescript
import { createSnake, AnimalRoamBehavior, type SnakeConfig } from 'engine/animal/index.js';
import { Spawner } from 'engine/Spawner.js';

// 🐍 COBRA — green with diamond pattern
const COBRA_CONFIG: SnakeConfig = {
    segmentCount: 14,
    headColor: 0x2D5A27,
    bodyColor: 0x1B3F1B,
    bellyColor: 0x8FBC8F,
    patternColor: 0x3E8B3E,
    patternType: 'diamonds',
    bodyThickness: 0.12,
    totalLength: 2.0,
    moveSpeed: 2.5,
    eyes: {
        scleraColor: 0xCCCC00,  // Yellow sclera (default for snakes)
        color: 0x111100,         // Dark slit pupil (default for snakes)
    },
};

const spawner = new Spawner(engine);
const spawnPos = spawner.findValidSpawnPositionNear(spawner.getPlayerSpawnPosition(), {
    minDistance: 5,
    maxDistance: 20,
});

const cobra = await createSnake(scene, physics, engine, spawnPos!, 'Cobra', COBRA_CONFIG);
cobra.setBehavior(new AnimalRoamBehavior({ roamRadius: 12 }));
```

### More Snake Varieties

```typescript
// 🐍 RATTLESNAKE — brown with zigzag pattern
const RATTLESNAKE_CONFIG: SnakeConfig = {
    segmentCount: 10,
    headColor: 0x8B6914,
    bodyColor: 0x6B4423,
    bellyColor: 0xD2B48C,
    patternColor: 0x3D2B1F,
    patternType: 'zigzag',
    bodyThickness: 0.11,
    totalLength: 1.2,
    moveSpeed: 1.5,
};

// 🐍 KING COBRA — large, dark, striped
const KING_COBRA_CONFIG: SnakeConfig = {
    segmentCount: 20,
    headColor: 0x2F1B0E,
    bodyColor: 0x1A0F05,
    bellyColor: 0xC8A882,
    patternColor: 0x4A3728,
    patternType: 'stripes',
    bodyThickness: 0.15,
    totalLength: 3.5,
    scale: 1.0,
    moveSpeed: 3.0,
};

// 🐍 CORAL SNAKE — red/black/yellow banding
const CORAL_SNAKE_CONFIG: SnakeConfig = {
    segmentCount: 16,
    headColor: 0x111111,
    bodyColor: 0xCC0000,
    patternColor: 0x111111,
    patternType: 'stripes',
    bodyThickness: 0.06,
    totalLength: 1.0,
    moveSpeed: 2.0,
};

// 🐍 PYTHON — large, thick, diamond patterned
const PYTHON_CONFIG: SnakeConfig = {
    segmentCount: 24,
    headColor: 0x5C4033,
    bodyColor: 0x8B7355,
    bellyColor: 0xF5DEB3,
    patternColor: 0x3B2F2F,
    patternType: 'diamonds',
    bodyThickness: 0.18,
    totalLength: 4.0,
    moveSpeed: 1.5,
};

// 🐍 SMALL GARDEN SNAKE — tiny, fast
const GARDEN_SNAKE_CONFIG: SnakeConfig = {
    segmentCount: 8,
    headColor: 0x228B22,
    bodyColor: 0x2E8B57,
    bellyColor: 0x90EE90,
    bodyThickness: 0.04,
    totalLength: 0.5,
    moveSpeed: 3.0,
};
```

### Spawning Multiple Snakes

```typescript
const alreadySpawned: Array<{x: number, z: number, radius?: number}> = [];

for (let i = 0; i < 5; i++) {
    const pos = spawner.findValidSpawnPositionNear(playerSpawn, {
        minDistance: 8,
        maxDistance: 30,
        occupiedPositions: alreadySpawned,
    });
    if (pos) {
        alreadySpawned.push({ x: pos.x, z: pos.z, radius: 3 });
        const snake = await createSnake(scene, physics, engine, pos, `Snake_${i}`, COBRA_CONFIG);
        snake.setBehavior(new AnimalRoamBehavior({ roamRadius: 10 }));
    }
}
```

### Snake vs Animal — When to Use Which

| Creature | System | Import |
|----------|--------|--------|
| Dog, cat, horse, deer, cow, bear, lion, elephant, etc. | Animal (`createAnimal`) | `engine/animal/index.js` |
| Snake, serpent, worm, eel | Snake (`createSnake`) | `engine/animal/index.js` |
| Human, humanoid, zombie, skeleton | NPC (`NpcController`) | `engine/npc/index.js` |

### Key Differences from Animals

- **No legs** — snakes have segments instead of leg groups
- **No `shoulderHeight`** — use `scale` and `totalLength` to control size
- **No riding** — snakes cannot be ridden
- **Same behaviors** — `AnimalRoamBehavior`, `AnimalSwimBehavior`, `AnimalFlyBehavior` all work; `setBehavior()` takes any `INpcBehavior`, so NPC behaviours like `NpcFollowBehavior` drop in too
- **Same combat** — snakes implement `IDamageable`, can be hit and killed, explode into blocks on death
- **Pattern types** — snakes support `'stripes'`, `'diamonds'`, `'zigzag'` patterns applied along the body
- **Slit pupils** — snake eyes default to yellow sclera with dark vertical-slit pupils

### SnakeController API

```typescript
// Movement
snake.setMoveSpeed(3.0);
snake.getMoveSpeed();

// Behavior
snake.setBehavior(new AnimalRoamBehavior({ roamRadius: 15 }));
snake.setBehavior(new NpcFollowBehavior({ target: 'player' })); // from 'engine/npc/index.js'

// Combat
snake.takeDamage(50);
snake.isDead();
snake.isExploded();
snake.getHealth();
snake.setDebrisLifetime(5000); // Explosion debris duration

// Custom hit handling
snake.onMeleeHit = (dir, impulse) => {
    snake.takeDamage(9999); // One-hit kill
};

// Death callback
snake.onDeathEffect = () => {
    console.log('Snake killed!');
};
```

## Runtime tuning on a live snake

```typescript
snake.setMaxHealth(250);            // retune the ceiling (also refills and revives)
snake.heal(25);                     // returns false if already full or dead; onDamage does NOT fire
snake.resetHealth();                // full health, revived

snake.setArrivalRadius(0.2);        // stop closer to the final destination (default 0.5m)
snake.setAvoidanceEnabled(false);   // stop steering around other agents, and stop being avoided
snake.setStraightLinePath(true);    // skip navmesh A*; you own obstacle routing
```

Read back with `snake.getArrivalRadius()`, `snake.isAvoidanceEnabled()`, `snake.isStraightLinePath()` and `snake.getCurrentSpeed()` (m/s, sampled each update).

**Route state** — `snake.isFollowingPath()` while it is still walking a route, `snake.hasReachedDestination()` for the inverse. Do NOT test `getPath().length === 0`: arrival advances the waypoint index past the last waypoint rather than clearing the array, so the length only drops to zero once the stuck-detector wipes the path (~2s) — which looks like a long unexplained pause. Inspect with `snake.getPath()`, `snake.getCurrentWaypoint()`, `snake.getCurrentWaypointIndex()`.

**Debris** — after `snake.setDebrisLifetime(0)` you own the exploded blocks: `snake.getExplodedDebris()` returns `{ mesh, body }` per piece, and `snake.removeDebrisPiece(mesh)` cleans one up (returns `false` if it was not found).

**Corpse timing** — `snake.setCorpseLifetimeMs(ms)` controls how long the body lingers after a ragdoll death; `<= 0` keeps it until `dispose()`, and it applies immediately so it also retunes a corpse already down. At spawn that value comes from `damageable.debrisLifetimeMs`, which also drives explosion-debris lifetime — this setter is the only independent control. `snake.hasRagdoll()` reports whether the corpse body is still there; `snake.isRagdolled()` whether the death collapsed into a ragdoll at all — with `ragdollOnDeath` off, `isDead()` is true while `isRagdolled()` stays false.
