/**
 * Exact ground-plane (XZ) separation between two oriented chassis boxes —
 * pure math, unit-testable without Rapier.
 *
 * Car-to-car logic (are these two touching? which way do they part?) must be
 * answered from the actual box geometry, never from centre-to-centre distance:
 * a centre-distance test fires on cars that are still a metre apart, and two
 * cars racing side by side sit closer, centre to centre, than two cars queued
 * nose to tail. Both readings are wrong in the direction that hurts most.
 *
 * The XZ shadow of an oriented box is a zonotope (a hexagon in general, a
 * rectangle when the box is level), so SAT over the six candidate axes — the
 * perpendiculars of each box's three projected axes — gives the exact gap and
 * the exact minimum-penetration direction. Vertical overlap is checked
 * separately from each box's world Y span, which is all a car needs (one car
 * on a bridge over another must not read as contact).
 */

export interface Vec3Like { x: number; y: number; z: number }
export interface QuatLike { x: number; y: number; z: number; w: number }

/** Ground-plane shadow of an oriented box, plus its world vertical span. */
export interface BoxFootprint {
    /** Box centre, world XZ. */
    cx: number;
    cz: number;
    /** The box's three world axes, each scaled by its half extent, projected to XZ. */
    axes: Array<{ x: number; z: number }>;
    /** World Y span of the box. */
    minY: number;
    maxY: number;
    /** Conservative horizontal radius (centre to farthest corner). */
    radius: number;
}

/** Separation of two footprints along the best separating axis. */
export interface FootprintSeparation {
    /** Gap in metres along that axis. Negative = overlapping, and equals the penetration depth. */
    gap: number;
    /** Unit axis in XZ, pointing from `b` towards `a` (the direction to push `a`). */
    nx: number;
    nz: number;
}

/**
 * Build the footprint of a box given its world centre, world rotation and
 * half extents (exactly what a Rapier cuboid collider reports).
 */
export function boxFootprint(center: Vec3Like, rotation: QuatLike, halfExtents: Vec3Like): BoxFootprint {
    const { x, y, z, w } = rotation;
    // Columns of the rotation matrix = the box's world axes.
    const cols = [
        { x: 1 - 2 * (y * y + z * z), y: 2 * (x * y + z * w), z: 2 * (x * z - y * w) },
        { x: 2 * (x * y - z * w), y: 1 - 2 * (x * x + z * z), z: 2 * (y * z + x * w) },
        { x: 2 * (x * z + y * w), y: 2 * (y * z - x * w), z: 1 - 2 * (x * x + y * y) },
    ];
    const he = [halfExtents.x, halfExtents.y, halfExtents.z];

    const axes: Array<{ x: number; z: number }> = [];
    let ySpan = 0;
    let radius = 0;
    for (let i = 0; i < 3; i++) {
        const col = cols[i]!;
        const h = he[i]!;
        axes.push({ x: col.x * h, z: col.z * h });
        ySpan += Math.abs(col.y * h);
        radius += Math.hypot(col.x * h, col.z * h);
    }

    return {
        cx: center.x,
        cz: center.z,
        axes,
        minY: center.y - ySpan,
        maxY: center.y + ySpan,
        radius,
    };
}

/** Half-width of a footprint projected onto the unit axis (nx, nz). */
function projectedRadius(f: BoxFootprint, nx: number, nz: number): number {
    let r = 0;
    for (const a of f.axes) r += Math.abs(a.x * nx + a.z * nz);
    return r;
}

/**
 * Exact XZ gap between two footprints. Positive = that many metres apart;
 * negative = overlapping by that much, with (nx, nz) the shallowest way out.
 *
 * Degenerate candidate axes (an upright car's vertical axis projects to a
 * point) are skipped — they carry no information and would normalise to noise.
 */
export function footprintSeparation(a: BoxFootprint, b: BoxFootprint): FootprintSeparation {
    const dx = a.cx - b.cx;
    const dz = a.cz - b.cz;

    let bestGap = -Infinity;
    let bestX = 1;
    let bestZ = 0;

    const consider = (ax: number, az: number): void => {
        // Candidate axis = perpendicular of a projected box axis.
        const len = Math.hypot(ax, az);
        if (len < 1e-6) return;
        const nx = -az / len;
        const nz = ax / len;
        const dist = dx * nx + dz * nz;
        const gap = Math.abs(dist) - projectedRadius(a, nx, nz) - projectedRadius(b, nx, nz);
        if (gap > bestGap) {
            bestGap = gap;
            // Point the normal from b towards a so callers can push a along it.
            const sign = dist < 0 ? -1 : 1;
            bestX = nx * sign;
            bestZ = nz * sign;
        }
    };

    for (const axis of a.axes) consider(axis.x, axis.z);
    for (const axis of b.axes) consider(axis.x, axis.z);

    if (bestGap === -Infinity) {
        // No usable axis at all (both boxes degenerate). Fall back to the
        // centre-to-centre direction so callers still get a sane normal.
        const len = Math.hypot(dx, dz);
        return len > 1e-6
            ? { gap: len - a.radius - b.radius, nx: dx / len, nz: dz / len }
            : { gap: -(a.radius + b.radius), nx: 1, nz: 0 };
    }

    return { gap: bestGap, nx: bestX, nz: bestZ };
}

/** Metres of shared world Y span. Positive = the boxes overlap vertically. */
export function verticalOverlap(a: BoxFootprint, b: BoxFootprint): number {
    return Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
}
