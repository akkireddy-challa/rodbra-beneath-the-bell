// Networking message protocol types and shared interfaces

// === Connection State Machine ===

export type NetworkState = 'disconnected' | 'lobby' | 'connecting' | 'connected';

export type PlayerLifeState = 'alive' | 'dead';

export interface PlayerLifeSnapshot {
    state: PlayerLifeState;
    /** Monotonically increasing for the lifetime of the owning NetworkManager. */
    revision: number;
}

// === Message Protocol ===

export interface NetworkMessage {
    type: 'state' | 'join' | 'leave' | 'ping' | 'event' | 'ack' | 'batch';
    senderId: string;
    timestamp: number;
    /** Server-assigned message ID for reliable delivery. Present on all relayed messages. */
    _msgId?: number;
}

/** Batch message: packs multiple outbound messages into a single WebSocket frame.
 *  Sent at a fixed interval (default 40ms / 25Hz). The server relays as-is with a single _msgId.
 *  Receiving clients unpack and process each sub-message individually. */
export interface BatchMessage extends NetworkMessage {
    type: 'batch';
    msgs: NetworkMessage[];
}

/** ACK message sent by clients to confirm receipt of messages. Not relayed to other clients. */
export interface AckMessage extends NetworkMessage {
    type: 'ack';
    /** Array of _msgId values being acknowledged. */
    msgIds: number[];
}

export interface StateMessage extends NetworkMessage {
    type: 'state';
    /** Opt-in player lifecycle; omitted by older games. Never inferred from visibility. */
    playerLifeState?: PlayerLifeSnapshot;
    networkId: string;
    position: { x: number; y: number; z: number };
    speed: number;
    /** Linear velocity in m/s. Used for dead reckoning (velocity-based position prediction between network updates). */
    velocity: { x: number; y: number; z: number };
    /** Display name of the owning player. Included in every state message so remote clients always know who owns this object. */
    playerName?: string;
    /** Current animation state (e.g. 'idle', 'walk', 'run', 'jump', 'attack'). Works for both humanoid AnimationState and animal AnimalAnimationState. */
    animState?: string;
    /** Attack animation identifier (motionId or attack move name) when animState is 'attack'. */
    attackId?: string;
    /** Custom animation motionId when playing a non-locomotion animation. */
    customAnimId?: string;
    /** Equipped weapon ID. Format: "melee:<type>" (e.g. "melee:sword") or "ranged:<type>" (e.g. "ranged:pistol"). Omit if no weapon. */
    equippedWeaponId?: string;
    /** Weapon aim yaw in radians (ranged weapons only, relative to character forward). */
    weaponAimYaw?: number;
    /** Weapon aim pitch in radians (ranged weapons only, negative = looking up). */
    weaponAimPitch?: number;
    /** Authoritative rotation as quaternion. Always sent by all clients. */
    quaternion: { x: number; y: number; z: number; w: number };
    /** Steering angle in radians for vehicle wheels. Used by NetworkVehicleController for wheel visuals. */
    steeringAngle?: number;
    /** Object type discriminator. Used by onUnknownObject to decide whether to create a character, vehicle, animal, or NPC controller. */
    objectType?: 'character' | 'vehicle' | 'animal' | 'npc';
    /** Animal species type (e.g. 'Dog', 'Horse', 'Tiger'). Only present when objectType is 'animal'. */
    animalType?: string;
    /**
     * Serialized BlockAnimalBodyConfig for the animal's visual appearance.
     * Included only in initial sync messages (first few state updates + forceCollectState),
     * NOT in every frame, to minimize bandwidth.
     * Remote clients use this to build identical block animal geometry.
     */
    animalConfig?: unknown;
    /**
     * Serialized NpcCustomizationConfig for the NPC's visual appearance.
     * Included only in initial sync messages (like animalConfig).
     * Remote clients use this with createCustomizedNpcFactory() to build identical NPC visuals.
     */
    characterConfig?: unknown;
}

export interface JoinMessage extends NetworkMessage {
    type: 'join';
    playerName: string;
}

export interface LeaveMessage extends NetworkMessage {
    type: 'leave';
}

export interface PingMessage extends NetworkMessage {
    type: 'ping';
    networkIds: string[];
}

export interface EventMessage extends NetworkMessage {
    type: 'event';
    eventName: string;
    data: Record<string, unknown>;
}

// === Shooting Sync ===

/** Data sent when a projectile is fired. Used by NetworkManager.sendShoot(). */
export interface ShootData {
    position: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
    speed: number;
    color?: number;
    radius?: number;
    gravityScale?: number;
}

// === Room Info (from HTTP API) ===

export interface RoomPlayerInfo {
    playerId: string;
    playerName: string;
}

export interface RoomInfo {
    roomId: string;
    gameId: string;
    name: string;
    clients: number;
    players: RoomPlayerInfo[];
    data: Record<string, unknown>;
}

// === Remote Player Tracking ===

export interface RemotePlayerInfo {
    playerId: string;
    playerName: string;
    lastPingTime: number;
}

// === Animation Sync Interfaces ===

/**
 * Owner-side: provides current animation state to include in network messages.
 * Implement this by reading from your CharacterAnimationController or AnimalAnimationController.
 *
 * USAGE (player character owner):
 *   animationProvider: {
 *       getAnimationState: () => animController.getCurrentState(),       // 'idle', 'run', 'jump', etc.
 *       getAttackId: () => animController.getIsAttacking() ? attackName : null,
 *       getCustomAnimId: () => animController.isPlayingCustom?.() ? motionId : null,
 *   }
 *
 * USAGE (animal owner):
 *   animationProvider: {
 *       getAnimationState: () => animalAnimController.getCurrentState(), // 'idle', 'walk', 'trot', 'run'
 *       getAttackId: () => null,
 *       getCustomAnimId: () => null,
 *   }
 */
export interface AnimationStateProvider {
    /** Return current animation state string (e.g. 'idle', 'run', 'attack', 'walk', 'trot') */
    getAnimationState(): string;
    /** Return attack move ID if currently attacking, or null */
    getAttackId(): string | null;
    /** Return custom animation motionId if playing one, or null */
    getCustomAnimId(): string | null;
    /** Return equipped weapon ID ("melee:<type>" or "ranged:<type>"), or null if no weapon equipped */
    getEquippedWeaponId?(): string | null;
    /** Return weapon aim yaw in radians, relative to character forward (ranged weapons only) */
    getWeaponAimYaw?(): number;
    /** Return weapon aim pitch in radians, negative = looking up (ranged weapons only) */
    getWeaponAimPitch?(): number;
}

/**
 * Receiver-side: applies animation state received from a network message.
 * Implement this to drive the remote character's animation controller.
 *
 * USAGE (remote humanoid player/NPC):
 *   animationReceiver: {
 *       applyAnimationState(animState, speed, attackId, customAnimId) {
 *           if (attackId && !remoteAnimController.getIsAttacking()) {
 *               remoteAnimController.startAttack();
 *           } else if (customAnimId) {
 *               remoteAnimController.playCustomAnimation?.(customAnimId);
 *           } else {
 *               const isMoving = animState !== 'idle';
 *               const isJumping = animState === 'jump';
 *               remoteAnimController.updateAnimation(isMoving, speed, !isJumping, isJumping);
 *           }
 *       }
 *   }
 *
 * USAGE (remote animal):
 *   animationReceiver: {
 *       applyAnimationState(animState, speed) {
 *           animalAnimController.setState(animState as AnimalAnimationState);
 *           animalAnimController.setSpeed(speed);
 *       }
 *   }
 */
export interface AnimationStateReceiver {
    /** Apply received animation state from network. Called when a state message arrives with animation data. */
    applyAnimationState(animState: string, speed: number, attackId?: string, customAnimId?: string): void;
}

/**
 * Receiver-side: applies weapon state received from a network message.
 * Handles equip/unequip of weapons and aim direction updates for ranged weapons.
 *
 * NetworkCharacterController creates this internally — game code does NOT need to implement it.
 */
export interface WeaponStateReceiver {
    /** Apply received weapon state. weaponId null = unequip. aimYaw/aimPitch for ranged weapon aim direction. */
    applyWeaponState(weaponId: string | null, aimYaw: number, aimPitch: number): void;
}

// === Vehicle Descriptor (sent via _vehicleEnter event) ===

/** Describes a vehicle's visual appearance for remote clients to build a ghost vehicle. */
export interface VehicleDescriptor {
    /**
     * Vehicle ASSET id when the vehicle was spawned from one
     * (spawnFromAsset). Ghost clients load the same asset's visuals and
     * swap them in; absent → the box-part ghost below is the visual.
     */
    assetId?: string;
    /** Chassis dimensions */
    chassisSize: { width: number; height: number; length: number };
    /** Chassis base color (hex) */
    chassisColor: number;
    /** Per-wheel visual configuration */
    wheels: Array<{
        position: { x: number; y: number; z: number };
        radius: number;
        width: number;
        suspensionRestLength: number;
        color?: number;
        isSteering: boolean;
    }>;
    /** Body parts placed on top of the chassis platform */
    bodyParts: Array<{
        position: { x: number; y: number; z: number };
        size: { width: number; height: number; length: number };
        color: number;
        isWindow?: boolean;
    }>;
}

// === NetworkObject Options ===

export interface NetworkObjectOptions {
    /** Player objects only. Included in periodic and forced join snapshots. */
    playerLifeState?: () => Readonly<PlayerLifeSnapshot> | null;
    /** Callback that returns the object's current speed (magnitude of velocity). Used for animation blending on remote clients. */
    speedGetter?: () => number;
    /** Callback that returns the object's current linear velocity vector. Used for dead reckoning on remote clients. */
    velocityGetter: () => { x: number; y: number; z: number };
    /** Minimum position change (meters) to trigger a sync. Default: 0.01 */
    positionThreshold?: number;
    /** Minimum quaternion rotation change to trigger a sync. Compared as 1-|dot| > threshold*0.01. Default: 0.01 */
    rotationThreshold?: number;
    /** Display name of the owning player. Included in every state message so remote clients can show name labels. */
    playerName?: string;
    /** Callback that returns the vehicle's current steering angle in radians. Vehicles only. */
    steeringAngleGetter?: () => number;
    /** Object type discriminator. Set to 'vehicle' for vehicle objects, 'animal' for animals, 'npc' for NPCs. Default: 'character'. */
    objectType?: 'character' | 'vehicle' | 'animal' | 'npc';
    /** Animal species type (e.g. 'Dog', 'Horse'). Only used when objectType is 'animal'. Sent in state messages so remote clients can build the correct block animal mesh. */
    animalType?: string;
    /**
     * Serialized BlockAnimalBodyConfig for the animal's visual appearance.
     * Only used when objectType is 'animal'. Included in initial sync messages
     * so remote clients build identical block geometry (same colors, shapes, proportions).
     */
    animalConfig?: unknown;
    /** Display name for the animal's floating label (e.g. 'Buffalo', 'Wolf Alpha'). Only used when objectType is 'animal'. */
    animalDisplayName?: string;
    /**
     * Serialized NpcCustomizationConfig for the NPC's visual appearance.
     * Only used when objectType is 'npc'. Included in initial sync messages
     * so remote clients build identical NPC visuals (same colors, clothing, features).
     */
    characterConfig?: unknown;
    /** Display name for the NPC's floating label (e.g. 'Guard', 'Merchant'). Only used when objectType is 'npc'. */
    npcDisplayName?: string;
    /** (Owner only) Provider for animation state. When set, animation fields are included in state messages. */
    animationProvider?: AnimationStateProvider;
    /** (Non-owner only) Receiver for animation state. When set, received animation state is forwarded here. */
    animationReceiver?: AnimationStateReceiver;
    /** (Non-owner only) Receiver for weapon state. When set, received weapon equip/aim state is forwarded here. */
    weaponReceiver?: WeaponStateReceiver;
}

// === Type Guards ===

export function isStateMessage(msg: NetworkMessage): msg is StateMessage {
    return msg.type === 'state';
}

export function isJoinMessage(msg: NetworkMessage): msg is JoinMessage {
    return msg.type === 'join';
}

export function isLeaveMessage(msg: NetworkMessage): msg is LeaveMessage {
    return msg.type === 'leave';
}

export function isPingMessage(msg: NetworkMessage): msg is PingMessage {
    return msg.type === 'ping';
}

export function isEventMessage(msg: NetworkMessage): msg is EventMessage {
    return msg.type === 'event';
}

export function isBatchMessage(msg: NetworkMessage): msg is BatchMessage {
    return msg.type === 'batch';
}

// === Sync Rate Constants ===

/** Active sync rate: ~60 updates per second when object is moving (16ms intervals, matches 60fps) */
export const ACTIVE_SYNC_INTERVAL = 0.016;
/** Idle sync rate: 1 update per second when object is stationary */
export const IDLE_SYNC_INTERVAL = 1.0;
/** Ping interval: heartbeat every 5 seconds */
export const PING_INTERVAL = 5.0;
/** Stale timeout: remove remote player after 10 seconds without ping */
export const STALE_TIMEOUT = 10.0;
/** Outbox flush interval: batch all outbound messages into one WebSocket frame at 25Hz */
export const BATCH_SEND_INTERVAL = 0.04;

/** Size of the msgId prefix in binary protocol frames (4-byte big-endian uint32). */
export const BINARY_MSG_ID_BYTES = 4;
