import type { VectorKeyframeTrack } from 'three';

/** Remove net travel, retaining cyclic pelvis sway and local weight shifts. */
export function removeLinearRootTravel(track: VectorKeyframeTrack): number {
    const { values, times } = track;
    if (times.length < 2) return 0;
    const last = values.length - 3;
    const dx = values[last]! - values[0]!;
    const dz = values[last + 2]! - values[2]!;
    const start = times[0]!;
    const span = times[times.length - 1]! - start;
    if (span <= 0) return 0;
    for (let frame = 0; frame < times.length; frame++) {
        const fraction = (times[frame]! - start) / span;
        values[frame * 3] = values[frame * 3]! - dx * fraction;
        values[frame * 3 + 2] = values[frame * 3 + 2]! - dz * fraction;
    }
    return Math.hypot(dx, dz);
}
