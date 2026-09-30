// NetworkObject: attach to any THREE.Object3D to sync it over the network.
// Owner sends state (position, quaternion, velocity, animation), non-owner receives and interpolates with dead reckoning.
// Rotation is ALWAYS quaternion-based — no euler/rotationY ambiguity.
import * as THREE from 'three';
import { NetworkInterpolation } from 'engine/networking/NetworkInterpolation.js';
import { NetworkAnimationSync } from 'engine/networking/NetworkAnimationSync.js';
import type { StateMessage, NetworkObjectOptions } from 'engine/networking/NetworkTypes.js';
import { ACTIVE_SYNC_INTERVAL, IDLE_SYNC_INTERVAL } from 'engine/networking/NetworkTypes.js';

export class NetworkObject {
    readonly networkId: string;
    readonly isOwner: boolean;
    private object3D: THREE.Object3D;

    // --- Owner state ---
    private lastSentPosition: THREE.Vector3 = new THREE.Vector3();
    private lastSentQuaternion: THREE.Quaternion = new THREE.Quaternion();
    private lastSentSpeed: number = 0;
    private speedGetter: (() => number) | null;
    private velocityGetter: () => { x: number; y: number; z: number };
    private steeringAngleGetter: (() => number) | null;
    private objectType: 'character' | 'vehicle' | 'animal' | 'npc' | undefined;
    private animalType: string | undefined;
    private animalConfig: unknown | undefined;
    private animalDisplayName: string | undefined;
    private characterConfig: unknown | undefined;
    private npcDisplayName: string | undefined;
    /**
     * Counts down from CONFIG_BURST_COUNT → 0. While > 0, config is included in
     * EVERY state message (burst phase). After that, config piggybacks on the
     * periodic resync timer so late-joiners still receive it.
     */
    private configSyncCountdown: number = 0;
    /** Seconds since last config resync (used after burst phase). */
    private configResyncTimer: number = 0;
    /** Resend entity config every N seconds so late joiners always get it. */
    private static readonly CONFIG_RESYNC_INTERVAL = 5;
    private static readonly CONFIG_BURST_COUNT = 3;
    private positionThreshold: number;
    private rotationThreshold: number;
    private playerName: string | undefined;

    // Adaptive sync timing (per-object)
    private syncTimer: number = 0;
    private isIdle: boolean = false;

    // --- Non-owner state ---
    private interpolation: NetworkInterpolation | null = null;

    // --- Animation sync (both owner and non-owner) ---
    private animationSync: NetworkAnimationSync | null = null;

    // Lifecycle
    private destroyed: boolean = false;
    private readonly playerLifeState: NetworkObjectOptions['playerLifeState'];

    constructor(
        object3D: THREE.Object3D,
        networkId: string,
        isOwner: boolean,
        options: NetworkObjectOptions,
    ) {
        this.object3D = object3D;
        this.playerLifeState = options.playerLifeState;
        this.networkId = networkId;
        this.isOwner = isOwner;
        this.speedGetter = options.speedGetter ?? null;
        this.velocityGetter = options.velocityGetter;
        this.steeringAngleGetter = options.steeringAngleGetter ?? null;
        this.objectType = options.objectType;
        this.animalType = options.animalType;
        this.animalConfig = options.animalConfig;
        this.animalDisplayName = options.animalDisplayName;
        this.characterConfig = options.characterConfig;
        this.npcDisplayName = options.npcDisplayName;
        // Include config in first few state messages (burst), then periodically
        if ((options.animalConfig || options.characterConfig) && isOwner) {
            this.configSyncCountdown = NetworkObject.CONFIG_BURST_COUNT;
        }
        this.positionThreshold = options.positionThreshold ?? 0.01;
        this.rotationThreshold = options.rotationThreshold ?? 0.01;
        this.playerName = options.playerName;

        // Set up animation + weapon sync if provider or receiver is given
        const hasAnimCallbacks = options.animationProvider || options.animationReceiver || options.weaponReceiver;
        if (hasAnimCallbacks) {
            this.animationSync = new NetworkAnimationSync(
                options.animationProvider ?? null,
                options.animationReceiver ?? null,
                options.weaponReceiver ?? null,
            );
        }

        if (isOwner) {
            // Snapshot initial state so first frame can detect change
            this.lastSentPosition.copy(object3D.position);
            this.lastSentQuaternion.copy(object3D.quaternion);
            this.lastSentSpeed = this.speedGetter?.() ?? 0;
        } else {
            // Non-owner: set up interpolation from current position + quaternion
            this.interpolation = new NetworkInterpolation(
                object3D.position.clone(),
                object3D.quaternion.clone(),
            );
        }
    }

    /**
     * (Owner only) Check if it's time to sync and collect current state.
     * Returns a partial StateMessage if the object should send, or null to skip.
     * Called by NetworkManager.update().
     */
    collectState(deltaTime: number, senderId: string): StateMessage | null {
        if (!this.isOwner || this.destroyed) return null;

        const currentInterval = this.isIdle ? IDLE_SYNC_INTERVAL : ACTIVE_SYNC_INTERVAL;
        this.syncTimer += deltaTime;
        if (this.syncTimer < currentInterval) return null;
        this.syncTimer = 0;

        const pos = this.object3D.position;
        const quat = this.object3D.quaternion;
        const speed = this.speedGetter?.() ?? 0;

        const posChanged = pos.distanceTo(this.lastSentPosition) > this.positionThreshold;
        // Quaternion dirty-check: 1 - |dot| > threshold means rotation changed.
        // dot = 1 for identical quats, < 1 when they differ.
        const dot = this.lastSentQuaternion.dot(quat);
        const rotChanged = (1 - Math.abs(dot)) > this.rotationThreshold * 0.01;
        const speedChanged = Math.abs(speed - this.lastSentSpeed) > 0.1;
        const changed = posChanged || rotChanged || speedChanged;

        if (changed) {
            this.isIdle = false;
        } else {
            this.isIdle = true;
        }

        // Always send (even idle sends 1Hz heartbeat state so remotes know we exist)
        this.lastSentPosition.copy(pos);
        this.lastSentQuaternion.copy(quat);
        this.lastSentSpeed = speed;

        const vel = this.velocityGetter();
        const msg: StateMessage = {
            type: 'state',
            senderId,
            timestamp: performance.now(),
            networkId: this.networkId,
            position: { x: pos.x, y: pos.y, z: pos.z },
            speed,
            velocity: { x: vel.x, y: vel.y, z: vel.z },
            quaternion: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
        };
        if (this.playerName) msg.playerName = this.playerName;
        if (this.objectType) msg.objectType = this.objectType;
        if (this.animalType) msg.animalType = this.animalType;

        // Include entity config: burst phase (first N messages) then periodic resync.
        // This ensures late-joining clients always receive the config needed to
        // build correct animal/NPC visuals, not just a generic fallback.
        const shouldIncludeConfig = this.shouldIncludeConfig(deltaTime);
        if (shouldIncludeConfig) {
            if (this.animalConfig) {
                msg.animalConfig = this.animalConfig;
                if (this.animalDisplayName) msg.playerName = this.animalDisplayName;
            }
            if (this.characterConfig) {
                msg.characterConfig = this.characterConfig;
                if (this.npcDisplayName) msg.playerName = this.npcDisplayName;
            }
        } else {
            // Always include display names even when config is omitted
            if (this.animalDisplayName) msg.playerName = this.animalDisplayName;
            if (this.npcDisplayName) msg.playerName = this.npcDisplayName;
        }

        // Steering angle for vehicles
        if (this.steeringAngleGetter) {
            msg.steeringAngle = this.steeringAngleGetter();
        }

        this.animationSync?.populateState(msg);
        this.populateLifeState(msg);
        return msg;
    }

    /**
     * (Owner only) Force-collect state for immediate flush (bypasses timer).
     * Used when a new player joins and all owners need to announce their objects.
     */
    forceCollectState(senderId: string): StateMessage {
        const pos = this.object3D.position;
        const quat = this.object3D.quaternion;
        const speed = this.speedGetter?.() ?? 0;

        this.lastSentPosition.copy(pos);
        this.lastSentQuaternion.copy(quat);
        this.lastSentSpeed = speed;

        const vel = this.velocityGetter();
        const msg: StateMessage = {
            type: 'state',
            senderId,
            timestamp: performance.now(),
            networkId: this.networkId,
            position: { x: pos.x, y: pos.y, z: pos.z },
            speed,
            velocity: { x: vel.x, y: vel.y, z: vel.z },
            quaternion: { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
        };
        if (this.playerName) msg.playerName = this.playerName;
        if (this.objectType) msg.objectType = this.objectType;
        if (this.animalType) msg.animalType = this.animalType;

        // Always include entity config in forced syncs (new player join)
        if (this.animalConfig) {
            msg.animalConfig = this.animalConfig;
            if (this.animalDisplayName) msg.playerName = this.animalDisplayName;
        }
        if (this.characterConfig) {
            msg.characterConfig = this.characterConfig;
            if (this.npcDisplayName) msg.playerName = this.npcDisplayName;
        }

        if (this.steeringAngleGetter) {
            msg.steeringAngle = this.steeringAngleGetter();
        }

        this.animationSync?.populateState(msg);
        this.populateLifeState(msg);
        return msg;
    }

    private populateLifeState(msg: StateMessage): void {
        const life = this.playerLifeState?.();
        if (!life) return;
        msg.playerLifeState = { ...life };
        if (life.state === 'dead') {
            msg.speed = 0;
            msg.velocity = { x: 0, y: 0, z: 0 };
            msg.animState = 'idle';
            delete msg.attackId;
            delete msg.customAnimId;
            delete msg.equippedWeaponId;
        }
    }

    /**
     * (Non-owner only) Apply received state from network message.
     * Pushes new target into interpolation buffer with velocity for dead reckoning.
     */
    applyState(msg: StateMessage): void {
        if (this.isOwner || this.destroyed || !this.interpolation) return;

        const pos = new THREE.Vector3(msg.position.x, msg.position.y, msg.position.z);
        const vel = new THREE.Vector3(msg.velocity.x, msg.velocity.y, msg.velocity.z);

        const quat = new THREE.Quaternion(msg.quaternion.x, msg.quaternion.y, msg.quaternion.z, msg.quaternion.w);

        this.interpolation.setTarget(
            pos, quat, msg.speed,
            msg.animState, msg.attackId, msg.customAnimId,
            vel, msg.steeringAngle,
        );
        // Apply animation state immediately (discrete, not interpolated)
        this.animationSync?.applyState(msg);
    }

    /**
     * (Non-owner only) Advance interpolation toward latest target.
     * Called every frame by NetworkManager.update().
     */
    updateInterpolation(deltaTime: number): void {
        if (this.isOwner || this.destroyed || !this.interpolation) return;
        this.interpolation.update(deltaTime, this.object3D);
    }

    /** Get interpolated speed (non-owner) or actual speed (owner). Useful for animation blending. */
    getCurrentSpeed(): number {
        if (this.isOwner) {
            return this.speedGetter?.() ?? 0;
        }
        return this.interpolation?.getCurrentSpeed() ?? 0;
    }

    /** Get the latest steering angle from interpolation (non-owner). For vehicle wheel visuals. */
    getSteeringAngle(): number {
        return this.interpolation?.getSteeringAngle() ?? 0;
    }

    /** Get the underlying THREE.Object3D */
    getObject3D(): THREE.Object3D {
        return this.object3D;
    }

    /** Stop syncing this object. Does NOT remove the Object3D from the scene. */
    destroy(): void {
        this.destroyed = true;
    }

    isDestroyed(): boolean {
        return this.destroyed;
    }

    /**
     * Decide whether this state message should include entity config.
     * Burst phase: every message for the first CONFIG_BURST_COUNT sends.
     * After that: once every CONFIG_RESYNC_INTERVAL seconds.
     */
    private shouldIncludeConfig(deltaTime: number): boolean {
        const hasConfig = !!(this.animalConfig || this.characterConfig);
        if (!hasConfig) return false;

        // Burst phase: always include
        if (this.configSyncCountdown > 0) {
            this.configSyncCountdown--;
            return true;
        }

        // Periodic resync phase
        this.configResyncTimer += deltaTime;
        if (this.configResyncTimer >= NetworkObject.CONFIG_RESYNC_INTERVAL) {
            this.configResyncTimer = 0;
            return true;
        }
        return false;
    }
}
