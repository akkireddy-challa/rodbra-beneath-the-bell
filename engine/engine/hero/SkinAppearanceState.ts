import { Vector3 } from 'three';

/** Material-only appearance controls. A facial rig can drive these alongside its
 * geometry; they do not add a facial rig to an unrigged mesh.
 */
export class SkinAppearanceState {
    readonly weights = new Vector3(); // forehead, smile, squint
    setFrame(frame: Readonly<Record<string, number>>): void {
        const read = (key: string) => {
            const value = frame[key] ?? 0;
            if (!Number.isFinite(value)) throw new Error(`Non-finite skin appearance control: ${key}`);
            return Math.max(0, Math.min(1, value));
        };
        this.weights.set(
            Math.max(read('browInnerUp'), (read('browOuterUpLeft') + read('browOuterUpRight')) / 2),
            (read('mouthSmileLeft') + read('mouthSmileRight')) / 2,
            (read('cheekSquintLeft') + read('cheekSquintRight')) / 2,
        );
    }
}
