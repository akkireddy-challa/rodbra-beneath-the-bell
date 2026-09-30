import * as THREE from 'three';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';
import { directionalWeights } from 'engine/animation/DirectionalLocomotion.js';

/** One composite Track A with a normal player lifecycle. Captures are sampled
 * at one contact-relative gait phase and blended in LOCAL joint space, then FK
 * produces the world pose for both renderers. No physics or terrain ownership.
 * Input players are dedicated, private samplers (never shared with Track B). */
export class DirectionalLocomotionPlayer extends MixamoAnimationPlayer {
    private readonly weights = [1, 0, 0, 0, 0, 0, 0, 0];
    private readonly targets = [1, 0, 0, 0, 0, 0, 0, 0];
    private samplers: MixamoAnimationPlayer[] = [];
    private joints: { target: THREE.Bone; sources: THREE.Bone[] }[] = [];
    private readonly rotation = new THREE.Quaternion();
    private readonly position = new THREE.Vector3();
    private ready = false;

    configure(samplers: MixamoAnimationPlayer[]): void {
        if (this.ready) throw new Error('Directional player is already configured');
        if (samplers.length !== 8) throw new Error('Directional locomotion requires all eight clips');
        this.samplers = samplers;
        for (const player of samplers) {
            player.setLoop(true);
            player.play();
            player.setLocomotionMode(true);
            // Cache the clip-only marker before the composite ever poses.
            player.getLocomotionContactPhase();
        }
        this.getLocomotionContactPhase();
        this.joints = [...this.getBoneMap()].map(([name, target]) => ({ target, sources: samplers.map(player => {
            const bone = player.getBoneMap().get(name);
            if (!bone) throw new Error(`Directional skeleton mismatch: ${name}`);
            return bone;
        }) }));
        this.ready = true;
    }

    setDirection(angle: number): void {
        if (Number.isFinite(angle)) directionalWeights(angle, this.targets);
    }

    override update(deltaTime: number): void {
        const dt = Number.isFinite(deltaTime) ? THREE.MathUtils.clamp(deltaTime, 0, .1) : 0;
        const alpha = 1 - Math.exp(-dt / .08);
        for (let i = 0; i < 8; i++) this.weights[i] = this.weights[i]! + (this.targets[i]! - this.weights[i]!) * alpha;
        super.update(dt);
        this.samplePose();
    }

    override setTime(time: number): void { super.setTime(time); this.samplePose(); }

    private samplePose(): void {
        if (!this.ready) return;
        const phase = this.getTime() / this.getDuration() - (this.getLocomotionContactPhase() ?? 0);
        for (let i = 0; i < 8; i++) {
            if (this.weights[i]! < 1e-6) continue;
            const player = this.samplers[i]!;
            const localPhase = phase + (player.getLocomotionContactPhase() ?? 0);
            player.setTime(((localPhase % 1 + 1) % 1) * player.getDuration());
        }
        for (const { target, sources } of this.joints) {
            let total = 0;
            for (let i = 0; i < 8; i++) {
                const weight = this.weights[i]!;
                if (weight < 1e-6) continue;
                const source = sources[i]!;
                if (total === 0) { this.rotation.copy(source.quaternion); this.position.copy(source.position); }
                else {
                    this.rotation.slerp(source.quaternion, weight / (total + weight));
                    this.position.lerp(source.position, weight / (total + weight));
                }
                total += weight;
            }
            target.quaternion.copy(this.rotation).normalize();
            target.position.copy(this.position);
        }
        this.getSkeletonRoot()?.updateMatrixWorld(true);
    }

    /** Weighted stride distance per shared reference cycle. This keeps unequal
     * duration jog clips phase-locked without giving either its own clock. */
    override getNativeLocomotionSpeed(): number {
        if (!this.ready) return super.getNativeLocomotionSpeed();
        let distance = 0, x = 0, z = 0;
        for (let i = 0; i < 8; i++) {
            const stride = this.weights[i]! * this.samplers[i]!.getNativeLocomotionSpeed() * this.samplers[i]!.getDuration();
            distance += stride;
            x += stride * Math.sin(i * Math.PI / 4); z += stride * Math.cos(i * Math.PI / 4);
        }
        // Neighboring directions shorten the resultant stride slightly. During
        // a sudden reversal, however, fading opposite samples must not cancel
        // the speed denominator and send cadence to infinity. Bound reduction
        // to the worst case of a normal 45-degree neighbor blend.
        return Math.max(Math.hypot(x, z), distance * Math.cos(Math.PI / 8)) / this.getDuration();
    }

    /** Copy for diagnostics; never expose mutable blend state. */
    getDirectionWeights(): readonly number[] { return [...this.weights]; }

    override dispose(): void {
        for (const player of this.samplers) player.dispose();
        this.samplers = []; this.joints = []; this.ready = false;
        this.weights.fill(0); this.weights[0] = 1;
        this.targets.fill(0); this.targets[0] = 1;
        super.dispose();
    }
}
