import * as THREE from 'three';

/** A quaternion's shortest arc is not temporally continuous when two moving
 * endpoints cross 180 degrees. Unwrap the relative rotation through a blend,
 * instead of choosing a new hemisphere independently on every frame. State
 * belongs to one blend channel and is reset when its sources/revisions change.
 * Exact endpoints start a fresh arc; no smoothing or angular cap alters clips. */
export class ContinuousQuaternionBlend {
    private key = '';
    private readonly history = new Map<string, THREE.Vector3>();
    private readonly relative = new THREE.Quaternion();
    private readonly axis = new THREE.Vector3();
    private readonly delta = new THREE.Quaternion();

    begin(key: string): void {
        if (key !== this.key) { this.reset(); this.key = key; }
    }

    reset(): void { this.key = ''; this.history.clear(); }

    sample(name: string, target: THREE.Quaternion, a: THREE.Quaternion, b: THREE.Quaternion, weight: number): void {
        if (weight >= 1) {
            this.history.delete(name);
            target.copy(b);
            return;
        }
        this.relative.copy(a).invert().multiply(b).normalize();
        if (this.relative.w < 0) this.relative.set(-this.relative.x, -this.relative.y, -this.relative.z, -this.relative.w);
        this.axis.set(this.relative.x, this.relative.y, this.relative.z);
        const sine = this.axis.length();
        let angle = 2 * Math.atan2(sine, this.relative.w);
        const previous = weight <= 0 ? undefined : this.history.get(name);
        if (sine > 1e-8) this.axis.multiplyScalar(1 / sine);
        else if (previous && previous.lengthSq() > 1e-8) this.axis.copy(previous).normalize();
        else this.axis.set(1, 0, 0);
        if (previous) angle += 2 * Math.PI * Math.round((previous.dot(this.axis) - angle) / (2 * Math.PI));
        const state = previous ?? new THREE.Vector3();
        state.copy(this.axis).multiplyScalar(angle);
        this.history.set(name, state);
        // Record the initial arc even at zero weight: the endpoint can pass
        // 180 degrees before the next rendered frame starts the fade.
        this.delta.setFromAxisAngle(this.axis, angle * Math.max(0, weight));
        target.copy(a).multiply(this.delta).normalize();
    }
}
