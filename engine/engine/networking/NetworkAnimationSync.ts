// NetworkAnimationSync: bridges NetworkObject with animation controllers.
// Handles dirty-checking on the owner side and deduplication on the receiver side.

import type { StateMessage, AnimationStateProvider, AnimationStateReceiver, WeaponStateReceiver } from 'engine/networking/NetworkTypes.js';

/**
 * Coordinator that manages animation state sync for a single NetworkObject.
 *
 * Owner side: reads from AnimationStateProvider, populates animation fields on StateMessage.
 * Receiver side: reads animation fields from StateMessage, forwards to AnimationStateReceiver.
 *
 * Tracks last-sent/last-applied state to avoid redundant operations.
 */
export class NetworkAnimationSync {
    private provider: AnimationStateProvider | null;
    private receiver: AnimationStateReceiver | null;
    private weaponReceiver: WeaponStateReceiver | null;

    // Owner: last sent values for dirty checking
    private lastSentAnimState: string = '';
    private lastSentAttackId: string | null = null;
    private lastSentCustomAnimId: string | null = null;
    private lastSentWeaponId: string | null = null;

    // Receiver: last applied values to avoid redundant calls
    private lastAppliedAnimState: string = '';
    private lastAppliedAttackId: string | null = null;
    private lastAppliedCustomAnimId: string | null = null;
    private lastAppliedWeaponId: string | null = null;

    constructor(
        provider: AnimationStateProvider | null,
        receiver: AnimationStateReceiver | null,
        weaponReceiver: WeaponStateReceiver | null = null,
    ) {
        this.provider = provider;
        this.receiver = receiver;
        this.weaponReceiver = weaponReceiver;
    }

    /**
     * (Owner only) Populate animation fields on an outgoing StateMessage.
     * Returns true if any animation field was set (even if unchanged — the message
     * always includes current animation state so new joiners get the full picture).
     */
    populateState(msg: StateMessage): boolean {
        if (!this.provider) return false;

        const animState = this.provider.getAnimationState();
        const attackId = this.provider.getAttackId();
        const customAnimId = this.provider.getCustomAnimId();

        msg.animState = animState;
        if (attackId) msg.attackId = attackId;
        if (customAnimId) msg.customAnimId = customAnimId;

        // Weapon state (optional provider methods)
        const weaponId = this.provider.getEquippedWeaponId?.() ?? null;
        if (weaponId) {
            msg.equippedWeaponId = weaponId;
            if (weaponId.startsWith('ranged:')) {
                msg.weaponAimYaw = this.provider.getWeaponAimYaw?.() ?? 0;
                msg.weaponAimPitch = this.provider.getWeaponAimPitch?.() ?? 0;
            }
        }

        const changed =
            animState !== this.lastSentAnimState ||
            attackId !== this.lastSentAttackId ||
            customAnimId !== this.lastSentCustomAnimId ||
            weaponId !== this.lastSentWeaponId;

        this.lastSentAnimState = animState;
        this.lastSentAttackId = attackId;
        this.lastSentCustomAnimId = customAnimId;
        this.lastSentWeaponId = weaponId;

        return changed;
    }

    /**
     * (Receiver only) Apply animation and weapon state from an incoming StateMessage.
     * Animation: skips if unchanged, except attacks which always forward.
     * Weapon: forwards on weapon change or when aim data is present (ranged).
     */
    applyState(msg: StateMessage): void {
        // --- Animation state ---
        if (this.receiver && msg.animState) {
            const animState = msg.animState;
            const attackId = msg.attackId ?? null;
            const customAnimId = msg.customAnimId ?? null;

            // Always forward attacks (same attackId can fire multiple times)
            const isAttack = animState === 'attack' && attackId !== null;
            const animChanged =
                isAttack ||
                animState !== this.lastAppliedAnimState ||
                attackId !== this.lastAppliedAttackId ||
                customAnimId !== this.lastAppliedCustomAnimId;

            if (animChanged) {
                this.lastAppliedAnimState = animState;
                this.lastAppliedAttackId = attackId;
                this.lastAppliedCustomAnimId = customAnimId;
                this.receiver.applyAnimationState(animState, msg.speed, attackId ?? undefined, customAnimId ?? undefined);
            }
        }

        // --- Weapon state ---
        if (this.weaponReceiver) {
            const weaponId = msg.equippedWeaponId ?? null;
            const aimYaw = msg.weaponAimYaw ?? 0;
            const aimPitch = msg.weaponAimPitch ?? 0;

            // Forward if weapon changed or ranged aim data present (aim changes continuously)
            const weaponChanged = weaponId !== this.lastAppliedWeaponId;
            const hasRangedAim = weaponId !== null && weaponId.startsWith('ranged:') && msg.weaponAimYaw !== undefined;

            if (weaponChanged || hasRangedAim) {
                this.lastAppliedWeaponId = weaponId;
                this.weaponReceiver.applyWeaponState(weaponId, aimYaw, aimPitch);
            }
        }
    }

    /** Whether this sync has a provider (owner-side animation collection). */
    hasProvider(): boolean {
        return this.provider !== null;
    }

    /** Whether this sync has a receiver (non-owner animation application). */
    hasReceiver(): boolean {
        return this.receiver !== null;
    }
}
