import * as THREE from 'three';
import type { BlockCharacterRenderer, BlockPosePartOffset, BlockPoseOverrideState } from 'engine/BlockCharacterRenderer.js';

/**
 * What a pose override owns when it is acquired. The part list is fixed here so
 * every owned part's base pose is captured on the SAME frame — a part added
 * later would be captured mid-breath and hold a slightly different pose.
 */
export interface NpcPoseOverrideOptions {
    /**
     * Body-part groups the override holds still: `head`, `neck`, `torso`,
     * `left|rightUpperArm`, `left|rightForearm`, `left|rightHand`,
     * `left|rightThigh`, `left|rightShin`, `left|rightFoot`. Everything not
     * listed keeps animating — that is how one arm gestures while the other
     * swings with the idle.
     */
    parts: string[];
    /** 0 = pure animation, 1 = the held pose alone. Fade it to blend in or out. */
    weight: number;
    /** Hold the height the character had on install, so a lean cannot sink it. */
    preserveRootHeight: boolean;
    /** Hold the feet where they were, so a lean cannot drag them off the floor. */
    preserveFeet: boolean;
}

/** Seated upper-body lean: torso and head held, height and feet pinned. */
export const DEFAULT_NPC_POSE_OVERRIDE_OPTIONS: NpcPoseOverrideOptions = {
    parts: ['torso', 'neck', 'head'],
    weight: 1,
    preserveRootHeight: true,
    preserveFeet: true,
};

/**
 * A held pose on one NPC: the parts it owns, an optional single-hand reach, and
 * the weight it blends at — acquired from `NpcController.acquirePoseOverride()`
 * and given back with `release()`.
 *
 * Every offset is measured from a base pose captured once, so setting the same
 * offset every frame produces the same pose instead of leaning a little further
 * each time. The parts the handle does not name are never touched.
 */
export class NpcPoseOverrideHandle {
    private readonly renderer: BlockCharacterRenderer;
    private readonly state: BlockPoseOverrideState;
    private readonly onRelease: () => void;
    private released = false;

    constructor(renderer: BlockCharacterRenderer, options: NpcPoseOverrideOptions, onRelease: () => void) {
        this.renderer = renderer;
        this.onRelease = onRelease;
        this.state = {
            // Seeded with a zero offset per part: owning a part means holding it
            // at its captured pose until the caller offsets it.
            parts: new Map(options.parts.map(part => [part, NpcPoseOverrideHandle.zeroOffset()])),
            weight: THREE.MathUtils.clamp(options.weight, 0, 1),
            preserveFeet: options.preserveFeet,
            preserveRootHeight: options.preserveRootHeight,
            armTarget: null,
        };
        renderer.setPoseOverride(this.state);
    }

    /** The body parts this override holds (the `parts` option, verbatim). */
    getOwnedParts(): string[] {
        return Array.from(this.state.parts.keys());
    }

    /**
     * Offset one owned part from its captured base pose. The offset is ABSOLUTE,
     * not cumulative: an omitted `position` means "no translation", an omitted
     * `rotation` means "no rotation", and calling this with the same values
     * every frame leaves the pose exactly where it is.
     *
     * `position` is a translation in the character's own frame; `rotation` is
     * applied on top of the part's captured orientation in that same frame.
     *
     * Throws when the part was not listed at acquire time — the base pose is
     * captured once, so a part the override never claimed has nothing to offset
     * from.
     */
    setPartOffset(part: string, offset: Partial<BlockPosePartOffset>): void {
        this.assertActive();
        const current = this.state.parts.get(part);
        if (!current) {
            throw new Error(
                `NpcPoseOverrideHandle: '${part}' is not owned by this pose override `
                + `(owned: ${this.getOwnedParts().join(', ') || 'none'}). `
                + `List it in the 'parts' option when acquiring the handle.`
            );
        }
        if (offset.position) current.position.copy(offset.position);
        else current.position.set(0, 0, 0);
        if (offset.rotation) current.rotation.copy(offset.rotation);
        else current.rotation.identity();
    }

    /** Return one owned part to its captured base pose (still held there). */
    clearPartOffset(part: string): void {
        this.setPartOffset(part, {});
    }

    /**
     * Reach ONE hand to a world point — the arm is laid out from its own
     * shoulder, and the other arm is left to the animation entirely, so a
     * character can raise a hand to its mouth without the second arm going
     * stiff or dangling.
     *
     * The arm parts do not need to be owned: the reach is solved from the live
     * shoulder every frame, and the arm goes back to the animation as soon as
     * the target is cleared. Only one arm can reach at a time — targeting the
     * other side moves the reach there and releases this one.
     */
    setHandTarget(side: 'left' | 'right', worldPosition: THREE.Vector3, rotation?: THREE.Quaternion): void {
        this.assertActive();
        const existing = this.state.armTarget;
        if (existing && existing.side === side) {
            existing.position.copy(worldPosition);
            if (rotation) existing.rotation.copy(rotation);
            else existing.rotation.identity();
            return;
        }
        this.state.armTarget = {
            side,
            position: worldPosition.clone(),
            rotation: rotation ? rotation.clone() : new THREE.Quaternion(),
        };
    }

    /** Stop reaching; the arm follows the animation again from the next frame. */
    clearHandTarget(): void {
        this.assertActive();
        this.state.armTarget = null;
    }

    /** Blend the whole held pose: 0 = pure animation, 1 = the pose alone. */
    setWeight(weight: number): void {
        this.assertActive();
        this.state.weight = THREE.MathUtils.clamp(weight, 0, 1);
    }

    /** Current blend weight (clamped to 0..1). */
    getWeight(): number {
        return this.state.weight;
    }

    /** False once `release()` has run — a released handle cannot be reused. */
    isActive(): boolean {
        return !this.released;
    }

    /**
     * Give the pose back: every part it captured returns to that exact
     * transform and follows the animation again. Safe to call twice.
     */
    release(): void {
        if (this.released) return;
        this.released = true;
        this.renderer.clearPoseOverride();
        this.onRelease();
    }

    private static zeroOffset(): BlockPosePartOffset {
        return { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
    }

    private assertActive(): void {
        if (this.released) {
            throw new Error('NpcPoseOverrideHandle: this pose override was released — acquire a new one.');
        }
    }
}
