/**
 * Collision Layer System
 * 
 * Defines collision groups and masks for physics filtering.
 * Uses bitmasks - each layer is a power of 2.
 * 
 * Usage:
 *   physicsWorld.addRigidBody(body, CollisionGroup.PLAYER, CollisionMask.PLAYER);
 */

/**
 * Collision groups - which layer an object belongs to.
 * Each group is a single bit.
 */
export const CollisionGroup = {
    PLAYER: 1,        // 0x0001 - Player character
    ENVIRONMENT: 2,   // 0x0002 - Static environment (buildings, trees, rocks) - NOT terrain
    ENEMY: 4,         // 0x0004 - Enemies/NPCs that can be hit
    PROJECTILE: 8,    // 0x0008 - Projectiles (player and enemy)
    VEHICLE: 16,      // 0x0010 - Vehicles
    TRIGGER: 32,      // 0x0020 - Trigger volumes (no physical response)
    DEBRIS: 64,       // 0x0040 - Physics debris (doesn't collide with other debris)
    ANIMAL: 128,      // 0x0080 - Animals/creatures
    DYNAMIC_PROP: 256, // 0x0100 - Dynamic props (furniture, crates) that collide with environment
    TERRAIN: 512,     // 0x0200 - Terrain only (voxel terrain chunks) - separate for spawn detection
    RAGDOLL: 1024,    // 0x0400 - Jointed death-ragdoll limb bodies (dynamic, self-collision disabled)
} as const;

/**
 * Collision masks - which groups an object collides WITH.
 * Combine groups with bitwise OR.
 */
export const CollisionMask = {
    // Player collides with: terrain, environment, vehicles, projectiles, triggers (NOT debris).
    // ENEMY and ANIMAL are intentionally excluded — the player does NOT hard-collide with NPCs or
    // animals via the Rapier solver. Those bodies are position-controlled (AI/teleport-driven), so a
    // shared solver contact lets a teleport into overlap eject the player with near-unbounded force
    // (launched skyward / punched through the ground). Player↔character interactions are surfaced via
    // sensor (trigger) colliders instead — game code decides the response. (Same rationale the VEHICLE
    // mask already uses for ENEMY/ANIMAL.) VEHICLE stays in the mask for stand-on / push behaviour; the
    // proper moving-platform carry is a kinematic-character-controller concern, not a solver contact.
    // DYNAMIC_PROP is also excluded from the SOLVER pairing: the player body is kinematic, so a solver
    // contact would shove props with effectively infinite mass. Instead the character controller treats
    // props as blocking obstacles (walk against / stand on them) — enabled by the PLAYER bit kept in the
    // DYNAMIC_PROP mask below — and the character motor applies small capped push impulses so the player
    // can still slowly shove props around.
    PLAYER: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.VEHICLE |
            CollisionGroup.PROJECTILE |
            CollisionGroup.TRIGGER,

    
    // Environment collides with: everything except triggers (including dynamic props and ragdoll limbs)
    ENVIRONMENT: CollisionGroup.PLAYER | CollisionGroup.ENEMY | CollisionGroup.PROJECTILE |
                 CollisionGroup.VEHICLE | CollisionGroup.DEBRIS | CollisionGroup.ANIMAL | CollisionGroup.DYNAMIC_PROP |
                 CollisionGroup.RAGDOLL,

    // Terrain collides with: same as environment (player, enemies, vehicles, ragdoll limbs, etc.)
    TERRAIN: CollisionGroup.PLAYER | CollisionGroup.ENEMY | CollisionGroup.PROJECTILE |
             CollisionGroup.VEHICLE | CollisionGroup.DEBRIS | CollisionGroup.ANIMAL | CollisionGroup.DYNAMIC_PROP |
             CollisionGroup.RAGDOLL,
    
    // Enemy collides with: terrain, environment, projectiles, player (one-sided), triggers.
    // ENEMY (self), VEHICLE and DYNAMIC_PROP stay excluded — NPC bodies are position-controlled
    // (AI/teleport-driven), so letting the Rapier SOLVER resolve a contact between such a body and a
    // DYNAMIC body it can move (a vehicle or a dynamic prop) produces unbounded ejection impulses.
    // NPC↔NPC/prop spacing is handled by the navmesh/agent-avoidance layer, not physics.
    // PLAYER is included here so the PLAYER's kinematic-character-controller (collide-and-slide) treats
    // NPCs as solid obstacles — the player can no longer walk through enemies. This is the filter half
    // of a one-sided pairing: the PLAYER mask deliberately does NOT include ENEMY, so the player's own
    // KCC blocks on NPCs while NPCs (which move by path-driven setNextKinematicTranslation, not a KCC)
    // are unaffected and still reach the player. Both bodies are kinematic, so there is NO solver
    // contact between them and thus none of the launch behaviour the dynamic-prop exclusion guards
    // against — collide-and-slide applies no impulses.
    // TRIGGER is included so sensor colliders that explicitly target NPCs can detect them — Rapier
    // requires the bit on BOTH the sensor's filter AND the NPC's filter for an intersection to fire.
    // The vehicle chassis impact sensor (group TRIGGER, filter PLAYER|ENEMY|ANIMAL) is the case this
    // enables; generic player-only triggers (filter = CollisionMask.TRIGGER = PLAYER) still ignore
    // NPCs because their half of the two-sided test fails (ENEMY ∉ a PLAYER-only filter).
    ENEMY: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT |
           CollisionGroup.PROJECTILE | CollisionGroup.TRIGGER | CollisionGroup.PLAYER,
    
    // Projectile collides with: terrain, environment, enemies, animals, dynamic
    // props (NOT the player who fired, NOT other projectiles, and NOT debris —
    // corpse-shatter and destruction chunks are cosmetic wreckage, and letting
    // bullets detonate on them meant rapid fire into one spot built a chunk
    // cloud at the point of aim that ate every following shot: it read as
    // bullets "ricocheting off the crosshair". Explosions still move debris
    // through their AOE impulse.)
    PROJECTILE: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.ENEMY | CollisionGroup.ANIMAL | CollisionGroup.DYNAMIC_PROP,
    
    // Enemy projectile collides with: terrain, environment, player (NOT enemies, NOT other projectiles)
    ENEMY_PROJECTILE: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.PLAYER,
    
    // Vehicle collides with: terrain, environment, player, other vehicles, dynamic props.
    // ENEMY and ANIMAL are intentionally excluded — NPCs and animals do NOT directly collide
    // with vehicles via Rapier. Instead, a sensor (trigger) collider on the chassis fires
    // `onCharacterImpact` events; game code chooses the response (ragdoll, impulse, sound, etc.).
    // PLAYER stays in the mask so the player can stand on a flat-bed / get pushed by a moving vehicle.
    // RAGDOLL is included so a moving (dynamic) chassis plows through a death ragdoll — the solver
    // transfers the car's real momentum for free, no game code.
    VEHICLE: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.PLAYER |
             CollisionGroup.VEHICLE | CollisionGroup.DYNAMIC_PROP | CollisionGroup.RAGDOLL,
    
    // Trigger collides with: player only (for detection)
    TRIGGER: CollisionGroup.PLAYER,
    
    // Debris collides with: terrain, environment, dynamic props (NOT player,
    // NOT other debris, NOT projectiles — see the PROJECTILE mask note).
    DEBRIS: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.DYNAMIC_PROP,

    /**
     * Same collide-with set as DEBRIS; kept for Physics2D call sites that already use this name.
     * Membership is still `CollisionGroup.DEBRIS`.
     */
    DEBRIS_FILTER_PHYSICS2D: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.DYNAMIC_PROP,
    
    // Animal collides with: terrain, environment, projectiles, player (one-sided), triggers.
    // ANIMAL (self), VEHICLE and DYNAMIC_PROP stay excluded — see the ENEMY mask for the full
    // rationale (no solver contact with DYNAMIC bodies). PLAYER is included so the player's
    // kinematic-character-controller treats animals as solid obstacles (the player can't walk through
    // them); it's the one-sided filter half — the PLAYER mask omits ANIMAL, so animals (path-driven,
    // no KCC) are unaffected and both bodies being kinematic means no solver contact / no launch.
    // TRIGGER is included so sensors that explicitly target animals can detect them (see the ENEMY
    // mask note) — notably the vehicle chassis impact sensor. Player-only triggers still ignore animals.
    ANIMAL: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT |
            CollisionGroup.PROJECTILE | CollisionGroup.TRIGGER | CollisionGroup.PLAYER,
    
    // Dynamic props collide with: terrain, environment, vehicles, other dynamic props.
    // ENEMY and ANIMAL are intentionally excluded (mirrors the ENEMY/ANIMAL masks) — kinematic,
    // position-controlled characters must not impart solver forces to props (they would otherwise
    // shove, or violently launch, any dynamic prop). Characters route around them via the navmesh.
    // The PLAYER bit here is one-sided ON PURPOSE: the PLAYER mask above does NOT include
    // DYNAMIC_PROP, so the solver never pairs player↔prop. The bit instead acts as the gate the
    // character controller's filter test uses to decide that PROPS BLOCK THE PLAYER (stand on /
    // walk against) while NPCs/animals pass through; pushes come from capped motor impulses.
    DYNAMIC_PROP: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.PLAYER |
                  CollisionGroup.VEHICLE | CollisionGroup.DYNAMIC_PROP | CollisionGroup.RAGDOLL,

    // Ragdoll limbs collide with the static world and all DYNAMIC bodies (vehicle chassis, props),
    // never the KINEMATIC character capsules (PLAYER/ENEMY/ANIMAL would shove the corpse with infinite
    // mass). PROJECTILE is excluded — a bullet despawns before the corpse exists, so its knockback is
    // applied via the damage path instead. RAGDOLL self-collision is toggled per-collider, not here.
    RAGDOLL: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.DYNAMIC_PROP |
             CollisionGroup.VEHICLE,

    // All groups (for special cases)
    ALL: 0xFFFF,
    
    // None (ghost objects)
    NONE: 0,
    
    // Step climbing surfaces - player can auto-climb onto these (debris excluded — no capsule contact)
    WALKABLE: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.DYNAMIC_PROP | CollisionGroup.VEHICLE,
    
    // Ground / snap-down raycasts — same layers the player capsule resolves against (debris excluded)
    GROUND_CHECK: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.DYNAMIC_PROP | CollisionGroup.VEHICLE,

    /** @deprecated Use GROUND_CHECK — identical bitmask (kept for Physics2D and older call sites). */
    GROUND_CHECK_NO_DEBRIS: CollisionGroup.TERRAIN | CollisionGroup.ENVIRONMENT | CollisionGroup.DYNAMIC_PROP | CollisionGroup.VEHICLE,
    
    // Terrain only - for spawn detection (detect if position is on terrain vs building)
    TERRAIN_ONLY: CollisionGroup.TERRAIN,
} as const;

export type CollisionGroupType = typeof CollisionGroup[keyof typeof CollisionGroup];
export type CollisionMaskType = typeof CollisionMask[keyof typeof CollisionMask];

/**
 * Create Rapier collision groups value.
 * Rapier uses a 32-bit integer where:
 * - Lower 16 bits: membership groups (which layers this body belongs to)
 * - Upper 16 bits: filter groups (which layers this body collides with)
 * 
 * @param memberOf - The collision group this body belongs to (single group)
 * @param collidesWith - Bitmask of groups this body collides with
 * @returns Combined 32-bit collision groups value for Rapier
 */
export function makeCollisionGroups(memberOf: number, collidesWith: number): number {
    return (collidesWith << 16) | memberOf;
}

