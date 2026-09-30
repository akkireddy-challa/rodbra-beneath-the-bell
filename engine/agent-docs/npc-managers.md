# NPC Managers

`NpcManager` owns a *population* of one NPC type — use it when you need respawning, bulk spawns, or
per-instance setup that must survive a respawn. For a handful of NPCs, `engine.registerNpc()` +
`handle.spawn()` from `@docs npc-system.md` is enough.

## NPC managers — spawning, respawning, despawning

`NpcManager` owns a population of one NPC type. Create it once as a field, spawn in
`load()`, and the engine drives its update — you do NOT call `update()` yourself.

```typescript
// In Game.ts
private enemyManager = NpcManager.createEnemy(this.engine);

async load() {
    await this.enemyManager.spawnNpc(10, 5);   // auto-registers with the engine
}
```

Pass a character factory (and options) to control appearance and roaming bounds:

```typescript
import { createWarriorNpcFactory } from 'engine/npc/index.js';

const enemyManager = NpcManager.createEnemy(this.engine, { worldBounds: 15 }, createWarriorNpcFactory());
await enemyManager.spawnNpc(10, 5);
```

**Each `spawnNpc()` call ADDS one NPC** — it is not "set the population to N".

```typescript
for (let i = 0; i < 100; i++) await zombieManager.spawnNpc(randomX(), randomZ());
console.log(zombieManager.getCount());   // 100

const ids = await zombieManager.spawnMany(100);                       // random positions
const ids = await zombieManager.spawnMany(5, [{ x: 10, z: 10 }, { x: 20, z: 10 }]);

zombieManager.despawnNpc('ZombieNpc5');   // one
zombieManager.despawnNpc();               // all of them

zombieManager.forEach((npc, id) => npc.takeDamage(10, 'fire'));
```

Reading the population back — note the names, which are easy to guess wrong:

```typescript
const all = zombieManager.getAllNpcs();        // NOT getNpcs() — every live NPC
const one = zombieManager.getNpc('ZombieNpc5'); // a single NPC by id, or null
const n = zombieManager.getCount();
```

Respawn is requested from a death hook, not scheduled up front:

```typescript
npc.onDeathEffect = () => {
    manager.requestRespawn(npc.getId(), 10.0);   // seconds
};
```

Spawn relative to a placed world object instead of raw coordinates:

```typescript
const id = await princessManager.spawnNpcRelativeTo({ objectId: 'tower_001', relation: 'on_top' });
const id = await guardManager.spawnNpcRelativeTo({ objectId: 'gate_001', relation: 'in_front' });
```

## Manager behaviors — configure NPCs in the behavior, not in Game.ts

Extend `BaseNpcManagerBehavior` and configure each NPC in `onNpcCreated`, which fires
for the initial spawn AND every respawn. Configuring in `Game.ts` instead means
respawned NPCs come back unconfigured.

```typescript
export class VillagerManagerBehavior extends BaseNpcManagerBehavior {
    constructor() {
        super('Villager', false, 0, new NpcIdleBehavior());
    }

    onNpcCreated(npc: NpcController, engine: EngineLike): void {
        npc.setBehavior(new NpcIdleBehavior({ lookAtPlayer: true }));
    }

    onNpcUpdated(npc: NpcController, deltaTime: number, engine: EngineLike): boolean {
        return false;   // true requests a respawn
    }
}
```

For a type that needs no custom logic, skip the subclass:

```typescript
import { SimpleNpcManagerBehavior } from 'engine/npc/index.js';
import { NpcIdleBehavior } from 'engine/npc/index.js';

const villagerBehavior = new SimpleNpcManagerBehavior('Villager', new NpcIdleBehavior({ lookAtPlayer: true }));
```

`onNpcCreated` is also where per-NPC UI belongs, so respawns get it too:

```typescript
onNpcCreated(npc: NpcController, engine: EngineLike): void {
    const healthBar = new WorldSpaceHealthBar(engine, {
        target: npc.getCharacter(),
        getHealth: () => npc.getHealth(),
        getMaxHealth: () => npc.getMaxHealth(),
    });
    this.healthBars.set(npc.getId(), healthBar);
}
```

## Ready-made NPC types

```typescript
const enemy = await NpcFactory.createWanderingEnemy(engine, scene, physics, position, playerGLTF, characterFactory);
const guard = await NpcFactory.createPatrolGuard(engine, scene, physics, position, playerGLTF, characterFactory, waypoints);
const shopkeeper = await NpcFactory.createShopkeeper(engine, scene, physics, shopPos, playerGLTF, characterFactory);
```
