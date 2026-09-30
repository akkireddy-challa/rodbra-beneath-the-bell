/**
 * Triangle-vs-AABB overlap test (Akenine-Möller 13-axis SAT).
 *
 * Conservative: a triangle that merely clips a box corner returns true.
 * Pure function, no external dependencies.
 */

/**
 * True iff triangle (v0, v1, v2) overlaps the axis-aligned box centred at
 * `c` with half-extents `h`.
 */
export function triBoxOverlap(
    c: [number, number, number],
    h: [number, number, number],
    v0: [number, number, number],
    v1: [number, number, number],
    v2: [number, number, number],
): boolean {
    // Translate vertices to box-local space (centre at origin)
    const ax = v0[0] - c[0], ay = v0[1] - c[1], az = v0[2] - c[2];
    const bx = v1[0] - c[0], by = v1[1] - c[1], bz = v1[2] - c[2];
    const cx = v2[0] - c[0], cy = v2[1] - c[1], cz = v2[2] - c[2];

    const hx = h[0], hy = h[1], hz = h[2];

    // Edge vectors
    const e0x = bx - ax, e0y = by - ay, e0z = bz - az;
    const e1x = cx - bx, e1y = cy - by, e1z = cz - bz;
    const e2x = ax - cx, e2y = ay - cy, e2z = az - cz;

    // Absolute edge components (used in radius computations)
    const f0x = Math.abs(e0x), f0y = Math.abs(e0y), f0z = Math.abs(e0z);
    const f1x = Math.abs(e1x), f1y = Math.abs(e1y), f1z = Math.abs(e1z);
    const f2x = Math.abs(e2x), f2y = Math.abs(e2y), f2z = Math.abs(e2z);

    // Helper: separating-axis test along axis (cross(edge, aabb-axis)).
    // Projects the three vertices onto the axis and checks against the box radius.
    // Returns false if a separating axis is found (i.e. no overlap on this axis).
    function axisTest(
        aa: number, bb: number,
        fa: number, fb: number,
        v0a: number, v0b: number,
        v1a: number, v1b: number,
        v2a: number, v2b: number,
        ha: number, hb: number,
    ): boolean {
        const p0 = aa * v0a - bb * v0b;
        const p1 = aa * v1a - bb * v1b;
        const p2 = aa * v2a - bb * v2b;
        const min = Math.min(p0, p1, p2);
        const max = Math.max(p0, p1, p2);
        const rad = fa * ha + fb * hb;
        return !(min > rad || max < -rad);
    }

    // ─── 9 edge-cross-product axes ────────────────────────────────────────
    // Convention matches backup: axisTest(aa, bb, fa, fb, va, vb, ..., ha, hb)
    // where p = aa*va - bb*vb, rad = fa*ha + fb*hb.

    // e0 cross axes
    if (!axisTest(e0z, e0y, f0z, f0y,  ay, az,  by, bz,  cy, cz,  hy, hz)) return false;
    if (!axisTest(e0z, e0x, f0z, f0x,  ax, az,  bx, bz,  cx, cz,  hx, hz)) return false;
    if (!axisTest(e0y, e0x, f0y, f0x,  ax, ay,  bx, by,  cx, cy,  hx, hy)) return false;

    // e1 cross axes
    if (!axisTest(e1z, e1y, f1z, f1y,  ay, az,  by, bz,  cy, cz,  hy, hz)) return false;
    if (!axisTest(e1z, e1x, f1z, f1x,  ax, az,  bx, bz,  cx, cz,  hx, hz)) return false;
    if (!axisTest(e1y, e1x, f1y, f1x,  ax, ay,  bx, by,  cx, cy,  hx, hy)) return false;

    // e2 cross axes
    if (!axisTest(e2z, e2y, f2z, f2y,  ay, az,  by, bz,  cy, cz,  hy, hz)) return false;
    if (!axisTest(e2z, e2x, f2z, f2x,  ax, az,  bx, bz,  cx, cz,  hx, hz)) return false;
    if (!axisTest(e2y, e2x, f2y, f2x,  ax, ay,  bx, by,  cx, cy,  hx, hy)) return false;

    // ─── 3 AABB face axes (simple AABB overlap) ──────────────────────────

    if (Math.min(ax, bx, cx) > hx || Math.max(ax, bx, cx) < -hx) return false;
    if (Math.min(ay, by, cy) > hy || Math.max(ay, by, cy) < -hy) return false;
    if (Math.min(az, bz, cz) > hz || Math.max(az, bz, cz) < -hz) return false;

    // ─── Triangle-normal / plane axis ────────────────────────────────────

    // normal = cross(e0, e2_reversed) = cross(e0, v2-v0)
    const ex = cx - ax, ey = cy - ay, ez = cz - az; // v2 - v0 in local space
    const nx = e0y * ez - e0z * ey;
    const ny = e0z * ex - e0x * ez;
    const nz = e0x * ey - e0y * ex;

    // Project box onto the normal: choose vmin/vmax based on normal sign
    const vminx = nx > 0 ? -hx : hx;
    const vminy = ny > 0 ? -hy : hy;
    const vminz = nz > 0 ? -hz : hz;
    const vmaxx = nx > 0 ? hx : -hx;
    const vmaxy = ny > 0 ? hy : -hy;
    const vmaxz = nz > 0 ? hz : -hz;

    const d = -(nx * ax + ny * ay + nz * az); // plane distance
    if (nx * vminx + ny * vminy + nz * vminz + d > 0) return false;
    if (nx * vmaxx + ny * vmaxy + nz * vmaxz + d < 0) return false;

    return true;
}
