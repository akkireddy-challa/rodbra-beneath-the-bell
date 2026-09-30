import * as THREE from 'three';
import { ContinuousQuaternionBlend } from 'engine/animation/ContinuousQuaternionBlend.js';

export interface PoseTransform { position: THREE.Vector3; rotation: THREE.Quaternion }
export type AnimationPose = Map<string, PoseTransform>;

/** A separate pool: never retain a renderer's frame-local pose map. */
export class PoseBuffer {
    readonly pose: AnimationPose = new Map();
    private readonly pool: AnimationPose = new Map();

    copy(source: AnimationPose): AnimationPose {
        this.pose.clear();
        for (const [name, value] of source) {
            let slot = this.pool.get(name);
            if (!slot) {
                slot = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
                this.pool.set(name, slot);
            }
            slot.position.copy(value.position);
            slot.rotation.copy(value.rotation);
            this.pose.set(name, slot);
        }
        return this.pose;
    }
}

/** Short action handoffs in CHARACTER space, so a saved pose follows movement/yaw.
 * Interruption snapshots the last DISPLAYED result, including an unfinished blend.
 * Physics transforms are only read. The lift envelope follows the identical blend.
 */
export class PoseTransition {
    private readonly previous = new PoseBuffer();
    private readonly outgoing = new PoseBuffer();
    private key: string | null = null;
    private elapsed = Infinity;
    private previousLift = 0;
    private outgoingLift = 0;
    private readonly inverse = new THREE.Matrix4();
    private readonly worldRotation = new THREE.Quaternion();
    private readonly inverseRotation = new THREE.Quaternion();
    private readonly position = new THREE.Vector3();
    private readonly rotation = new THREE.Quaternion();
    private readonly rotationBlend = new ContinuousQuaternionBlend();

    apply(pose: AnimationPose, key: string, frame: THREE.Object3D | null,
        deltaSeconds: number, lift: number, duration = 0.12): number {
        frame?.updateWorldMatrix(true, false);
        this.inverse.copy(frame?.matrixWorld ?? PoseTransition.identity).invert();
        if (frame) frame.getWorldQuaternion(this.worldRotation);
        else this.worldRotation.identity();
        this.inverseRotation.copy(this.worldRotation).invert();
        if (this.key !== null && key !== this.key && this.previous.pose.size) {
            this.outgoing.copy(this.previous.pose);
            this.outgoingLift = this.previousLift;
            this.elapsed = 0;
        }
        this.key = key;
        this.rotationBlend.begin(key);
        if (this.elapsed < duration && duration > 0) {
            const t = THREE.MathUtils.smoothstep(this.elapsed, 0, duration);
            for (const [name, value] of pose) {
                const old = this.outgoing.pose.get(name);
                if (!old) continue;
                this.position.copy(old.position).applyMatrix4(frame?.matrixWorld ?? PoseTransition.identity);
                this.rotation.copy(this.worldRotation).multiply(old.rotation);
                value.position.lerpVectors(this.position, value.position, t);
                this.rotationBlend.sample(name, value.rotation, this.rotation, value.rotation, t);
            }
            lift = THREE.MathUtils.lerp(this.outgoingLift, lift, t);
            this.elapsed += Math.max(0, Math.min(deltaSeconds, 0.1));
        }
        for (const value of this.previous.copy(pose).values()) {
            value.position.applyMatrix4(this.inverse);
            value.rotation.premultiply(this.inverseRotation);
        }
        this.previousLift = lift;
        return lift;
    }

    reset(): void {
        this.rotationBlend.reset();
        this.key = null;
        this.elapsed = Infinity;
        this.previous.pose.clear();
        this.outgoing.pose.clear();
        this.previousLift = this.outgoingLift = 0;
    }

    private static readonly identity = new THREE.Matrix4();
}
