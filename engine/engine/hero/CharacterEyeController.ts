import { Euler, MathUtils, Mesh, Object3D, Quaternion } from 'three';

export interface CharacterEyeFrame {
    yaw: number;
    pitch: number;
    blinkLeft: number;
    blinkRight: number;
}

export const NEUTRAL_CHARACTER_EYE_FRAME: Readonly<CharacterEyeFrame> = {
    yaw: 0, pitch: 0, blinkLeft: 0, blinkRight: 0,
};

/** Explicit optical-eye nodes use local +Z forward, +Y up. Angles are radians.
 *
 * Own these channels either here or in AnimationMixer, never both concurrently.
 * The controller rotates eyeballs and drives authored eyelid morphs; it does not
 * infer anatomy, squash eyes, or modify the character's body skeleton.
 */
export class CharacterEyeController {
    private readonly eyes: Array<{ node: Object3D; rest: Quaternion }> = [];
    private readonly lids: Array<{ mesh: Mesh; index: number; side: 'blinkLeft' | 'blinkRight' }> = [];
    private readonly gazeLids: Array<{ mesh: Mesh; index: number; side: 'blinkLeft' | 'blinkRight'; direction: 'up' | 'down' }> = [];
    private readonly rotation = new Quaternion();
    private readonly euler = new Euler(0, 0, 0, 'YXZ');

    constructor(root: Object3D) {
        root.traverse(node => {
            if (node.userData.characterEye === true) {
                if (node.userData.forwardAxis !== '+Z') throw new Error('Unsupported optical eye forward axis');
                this.eyes.push({ node, rest: node.quaternion.clone() });
            }
            if (node instanceof Mesh && node.morphTargetDictionary && node.morphTargetInfluences) {
                for (const [name, index] of Object.entries(node.morphTargetDictionary)) {
                    if (name === 'eyeBlinkLeft' || name === 'eyeBlinkRight') {
                        this.lids.push({ mesh: node, index, side: name === 'eyeBlinkLeft' ? 'blinkLeft' : 'blinkRight' });
                    }
                    const gazeLid = /^eyeLidLook(Up|Down)(Left|Right)$/.exec(name);
                    if (gazeLid) this.gazeLids.push({ mesh: node, index, side: gazeLid[2] === 'Left' ? 'blinkLeft' : 'blinkRight', direction: gazeLid[1] === 'Up' ? 'up' : 'down' });
                }
            }
        });
    }

    get eyeCount(): number { return this.eyes.length; }
    get lidBindingCount(): number { return this.lids.length; }

    setFrame(frame: Readonly<CharacterEyeFrame>): void {
        if (!Object.values(frame).every(Number.isFinite)) throw new Error('Eye controls must be finite');
        this.euler.set(MathUtils.clamp(frame.pitch, -.35, .35), MathUtils.clamp(frame.yaw, -.5, .5), 0, 'YXZ');
        this.rotation.setFromEuler(this.euler);
        for (const { node, rest } of this.eyes) node.quaternion.copy(rest).multiply(this.rotation);
        for (const { mesh, index, side } of this.lids) {
            mesh.morphTargetInfluences![index] = MathUtils.clamp(frame[side], 0, 1);
        }
        for (const { mesh, index, side, direction } of this.gazeLids) {
            // Local +Z forward: positive X pitch looks down. Blink closure takes
            // precedence over the authored gaze-follow correction for that eye.
            const amount = MathUtils.clamp(frame.pitch * (direction === 'up' ? -1 : 1) / .35, 0, 1);
            mesh.morphTargetInfluences![index] = amount * (1 - MathUtils.clamp(frame[side], 0, 1));
        }
    }

    reset(): void { this.setFrame(NEUTRAL_CHARACTER_EYE_FRAME); }
}
