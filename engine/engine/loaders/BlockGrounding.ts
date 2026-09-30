import * as THREE from 'three';
import type { BlockCharacterRenderer } from 'engine/BlockCharacterRenderer.js';
import { computeCharacterBodyBox } from 'engine/character/CharacterBodyBounds.js';
import { resolveSkinnedLegBones, solveLegIKMap } from 'engine/loaders/LegIK.js';

/** Stable rest-height calibration for boxes. Posed bounds may correct a leg's
 * clearance, but never own the pelvis/root height. No terrain ray moves the body. */
export class BlockGrounding {
    readonly hips: THREE.Object3D | null;
    private readonly restLegHeight: number;
    private readonly restScale: number;
    private readonly restHipsLocal = new THREE.Vector3();
    private soleHeight = 0;
    private readonly box = new THREE.Box3();
    private readonly point = new THREE.Vector3();
    private readonly scale = new THREE.Vector3();
    private readonly rotation = new THREE.Quaternion();
    private readonly matrix = new THREE.Matrix4();

    constructor(private readonly renderer: BlockCharacterRenderer, private readonly skeleton: THREE.Object3D) {
        const candidates: THREE.Object3D[] = [];
        skeleton.traverse(node => { if ((node as THREE.Bone).isBone && /hips|pelvis/i.test(node.name)) candidates.push(node); });
        this.hips = candidates[0] ?? null;
        skeleton.updateWorldMatrix(true, true);
        const legs = [resolveSkinnedLegBones(skeleton, 'left'), resolveSkinnedLegBones(skeleton, 'right')];
        const lowest = Math.min(...legs.map(leg => leg ? leg.foot.getWorldPosition(this.point).y : Infinity));
        this.restLegHeight = this.hips && Number.isFinite(lowest) ? this.hips.getWorldPosition(this.point).y - lowest : NaN;
        this.restScale = skeleton.getWorldScale(this.scale).y;
        if (this.hips) skeleton.worldToLocal(this.hips.getWorldPosition(this.restHipsLocal));
        this.measureSoles();
    }

    /** Clothes can change sole thickness, but the current ankle angle must not
     * enter the calibration. Measure in the flat foot-group basis (-Y forward). */
    measureSoles(): number {
        const previous = this.soleHeight;
        this.soleHeight = 0;
        for (const side of ['left', 'right'] as const) {
            const foot = this.renderer.getBodyPart(`${side}Foot`);
            if (!foot) continue;
            foot.updateWorldMatrix(true, true);
            const inverse = foot.matrixWorld.clone().invert();
            const flat = new THREE.Matrix4().makeRotationX(-Math.PI / 2)
                .scale(foot.getWorldScale(new THREE.Vector3()));
            const visit = (node: THREE.Object3D): void => {
                if (node.userData.isUserAttached || node.userData.isVisualOnly || node.userData.noPhysics || node.userData.isMeleeWeapon) return;
                const mesh = node as THREE.Mesh;
                if (mesh.isMesh && mesh.geometry) {
                    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
                    this.matrix.copy(flat).multiply(inverse).multiply(mesh.matrixWorld);
                    this.box.copy(mesh.geometry.boundingBox!).applyMatrix4(this.matrix);
                    this.soleHeight = Math.max(this.soleHeight, -this.box.min.y);
                }
                for (const child of node.children) visit(child);
            };
            visit(foot);
        }
        return this.soleHeight - previous;
    }

    /** World shift, independent of the renderer root's previous offset. */
    shift(groundY: number, authored: { position: number; offset: number } | null): number | null {
        if (!this.hips || !Number.isFinite(this.restLegHeight)) return null;
        const scale = this.skeleton.getWorldScale(this.scale).y / this.restScale;
        const hipsY = authored?.position ?? this.hips.getWorldPosition(this.point).y;
        // Direct GLTF poses have no separate source sampler. Their rest point
        // still follows the skeleton frame, not the already-shifted block root.
        const offset = authored?.offset ?? hipsY - this.point.copy(this.restHipsLocal).applyMatrix4(this.skeleton.matrixWorld).y;
        return groundY + this.restLegHeight * scale + this.soleHeight + offset - hipsY;
    }

    /** Lift a penetrating shoe through its leg, leaving torso/physics and the
     * authored ankle quaternion untouched. Swing feet above ground are free. */
    clearFeet(groundY: number): void {
        if (this.renderer.hasPoseOverride()) return;
        for (const side of ['left', 'right'] as const) {
            const thigh = this.renderer.getBodyPart(`${side}Thigh`);
            const shin = this.renderer.getBodyPart(`${side}Shin`);
            const foot = this.renderer.getBodyPart(`${side}Foot`);
            if (!thigh || !shin || !foot || !this.renderer.canGroundLeg(side)) continue;
            computeCharacterBodyBox(foot, this.box);
            const lift = groundY - this.box.min.y;
            if (!(lift > 1e-5)) continue;
            const ankle = foot.getWorldPosition(new THREE.Vector3());
            const knee = shin.getWorldPosition(new THREE.Vector3()).multiplyScalar(2).sub(ankle);
            const hip = thigh.getWorldPosition(new THREE.Vector3()).multiplyScalar(2).sub(knee);
            const target = ankle.clone(); target.y += lift;
            const reach = hip.distanceTo(knee) + knee.distanceTo(ankle) - .001;
            if (reach <= 0) continue;
            const distance = target.distanceTo(hip);
            if (distance > reach) target.sub(hip).multiplyScalar(reach / distance).add(hip);
            const map = new Map([
                ['hip', { position: hip.clone(), rotation: thigh.getWorldQuaternion(new THREE.Quaternion()) }],
                ['knee', { position: knee.clone(), rotation: shin.getWorldQuaternion(new THREE.Quaternion()) }],
                ['ankle', { position: ankle.clone(), rotation: foot.getWorldQuaternion(new THREE.Quaternion()) }],
            ]);
            solveLegIKMap(map, { thigh: 'hip', shin: 'knee', foot: 'ankle' }, this.skeleton.getWorldQuaternion(this.rotation),
                { position: target, quaternion: map.get('ankle')!.rotation.clone() }, true);
            const newKnee = map.get('knee')!.position;
            this.movePart(thigh, hip.clone().add(newKnee).multiplyScalar(.5), map.get('hip')!.rotation);
            this.movePart(shin, newKnee.clone().add(target).multiplyScalar(.5), map.get('knee')!.rotation);
            this.movePart(foot, target, map.get('ankle')!.rotation);
        }
    }

    private movePart(part: THREE.Object3D, position: THREE.Vector3, rotation: THREE.Quaternion): void {
        part.position.copy(part.parent ? part.parent.worldToLocal(position) : position);
        if (part.parent) part.parent.getWorldQuaternion(this.rotation).invert(); else this.rotation.identity();
        part.quaternion.copy(this.rotation).multiply(rotation);
        part.updateMatrixWorld(true);
    }
}
