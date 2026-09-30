/**
 * Course furniture for a water race: the glowing ribbon that shows the racing
 * line, and the buoy gates the boats have to pass through.
 *
 * Open water has no track. On land the asphalt itself tells the player where to
 * go; on an empty sea, a lap course is invisible unless the game draws one —
 * which is why every boat racer paints a line on the water and stands markers
 * along it. Both are built here from one waypoint list so they can never
 * disagree about where the course actually runs.
 *
 * Everything CONFORMS TO THE WAVES: the ribbon's vertices and each buoy's
 * height and tilt are re-read from the shared ocean surface every frame, so the
 * course rides the swell instead of hovering through it. That is only possible
 * because `engine/water/OceanWaveField.ts` gives the CPU the same heights the
 * shader displaces to.
 *
 * The gate helpers double as the lap/checkpoint system: `gateCrossed()` is an
 * exact segment-vs-gate test, so a boat cannot skip a gate by being fast.
 *
 * Usage:
 *   const course = createBoatRaceCourse({ waypoints, surface: ocean });
 *   scene.add(course.group);
 *   // per frame, AFTER ocean.update(camera, t):
 *   course.update();
 *   if (course.gateCrossed(nextGate, prevBoatPos, boatPos)) nextGate++;
 */

import * as THREE from 'three';
import type { WaterSurfaceQuery } from 'engine/water/WaterSurfaceQuery.js';

export interface BoatRaceCourseOptions {
    /**
     * Course centreline in world space (Y ignored — the surface supplies it).
     * Treated as a CLOSED loop when `closed` is true, which is the normal case
     * for a lap race.
     */
    waypoints: THREE.Vector3[];
    closed: boolean;
    surface: WaterSurfaceQuery;
    /** Half-width of the painted ribbon (m). Full width is twice this. */
    halfWidth: number;
    /** Width of the bright edge band inside each side of the ribbon (m). */
    edgeWidth: number;
    /** Centreline samples per input waypoint. Higher = smoother curve. */
    subdivisions: number;
    /** Ribbon fill colour. */
    ribbonColor: THREE.ColorRepresentation;
    /** Ribbon edge colour — brighter than the fill reads as a painted lane line. */
    ribbonEdgeColor: THREE.ColorRepresentation;
    ribbonOpacity: number;
    /** Metres the ribbon floats above the water, to beat z-fighting. */
    ribbonLift: number;
    /** How many buoy gates to place around the course. 0 disables them. */
    gateCount: number;
    /** Distance from the centreline to each gate buoy (m). */
    gateHalfWidth: number;
    buoyColor: THREE.ColorRepresentation;
    buoyPostColor: THREE.ColorRepresentation;
    /** Extra decorative buoys scattered off-course. 0 disables them. */
    scatterBuoyCount: number;
    scatterRadius: number;
    seed: number;
}

export const DEFAULT_BOAT_RACE_COURSE_OPTIONS: Omit<BoatRaceCourseOptions, 'waypoints' | 'surface'> = {
    closed: true,
    halfWidth: 5,
    edgeWidth: 1.4,
    subdivisions: 8,
    ribbonColor: 0x53e79c,
    ribbonEdgeColor: 0xa8ffd2,
    ribbonOpacity: 0.46,
    ribbonLift: 0.12,
    gateCount: 10,
    gateHalfWidth: 11,
    buoyColor: 0xd4603c,
    buoyPostColor: 0xbe9a5e,
    scatterBuoyCount: 14,
    scatterRadius: 260,
    seed: 20260813,
};

/** One gate: the pair of buoys and the line between them a boat must cross. */
export interface CourseGate {
    /** Midpoint of the gate on the course centreline (world XZ; Y is sea level). */
    center: THREE.Vector3;
    /** Course direction at the gate (unit, world XZ). */
    forward: THREE.Vector3;
    /** Perpendicular to `forward` (unit, world XZ) — the gate line direction. */
    across: THREE.Vector3;
    halfWidth: number;
}

export interface BoatRaceCourse {
    /** Add to the scene. */
    readonly group: THREE.Group;
    readonly gates: readonly CourseGate[];
    /** Densely sampled centreline — also the AI racing line. */
    readonly centerline: readonly THREE.Vector3[];
    /** Re-seat the ribbon and buoys on the current wave surface. Once per frame. */
    update(): void;
    /**
     * Did a boat moving from `from` to `to` pass through gate `index` in the
     * course direction? A plane test alone would fire when the boat crosses the
     * gate's infinite line hundreds of metres off to the side, so this checks
     * the crossing point falls between the two buoys as well.
     */
    gateCrossed(index: number, from: THREE.Vector3, to: THREE.Vector3): boolean;
    /** Course position (m along the centreline) nearest to a world point. */
    distanceAlong(point: THREE.Vector3): number;
    /** Total centreline length (m). */
    readonly length: number;
    dispose(): void;
}

function makeRandom(seed: number): () => number {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/** Catmull-Rom resample of the waypoints into an evenly-ish spaced centreline. */
function buildCenterline(waypoints: THREE.Vector3[], closed: boolean, subdivisions: number): THREE.Vector3[] {
    if (waypoints.length < 2) return waypoints.map((p) => p.clone());
    const flat = waypoints.map((p) => new THREE.Vector3(p.x, 0, p.z));
    const curve = new THREE.CatmullRomCurve3(flat, closed, 'centripetal');
    const count = Math.max(8, waypoints.length * Math.max(1, Math.round(subdivisions)));
    return curve.getSpacedPoints(closed ? count : count - 1);
}

/**
 * Geometry for the mushroom markers, built once and shared by every buoy —
 * a course can carry fifty of them and they are all the same three shapes.
 */
interface BuoyParts {
    post: THREE.BufferGeometry;
    cap: THREE.BufferGeometry;
    collar: THREE.BufferGeometry;
    dispose(): void;
}

function buildBuoyParts(): BuoyParts {
    const post = new THREE.CylinderGeometry(0.22, 0.28, 2.2, 8);
    const cap = new THREE.ConeGeometry(1.15, 1.05, 10);
    const collar = new THREE.CylinderGeometry(0.40, 0.40, 0.18, 8);
    return {
        post, cap, collar,
        dispose(): void { post.dispose(); cap.dispose(); collar.dispose(); },
    };
}

/** A stubby mushroom marker: post, flared cap, and a collar where they meet. */
function buildBuoyMesh(
    parts: BuoyParts,
    capMaterial: THREE.Material,
    postMaterial: THREE.Material,
    scale: number,
): THREE.Group {
    const g = new THREE.Group();
    const post = new THREE.Mesh(parts.post, postMaterial);
    post.position.y = 1.1;
    g.add(post);
    const cap = new THREE.Mesh(parts.cap, capMaterial);
    cap.position.y = 2.5;
    g.add(cap);
    const collar = new THREE.Mesh(parts.collar, capMaterial);
    collar.position.y = 1.9;
    g.add(collar);
    g.scale.setScalar(scale);
    return g;
}

export function createBoatRaceCourse(
    options: Partial<BoatRaceCourseOptions> & Pick<BoatRaceCourseOptions, 'waypoints' | 'surface'>,
): BoatRaceCourse {
    const opts: BoatRaceCourseOptions = { ...DEFAULT_BOAT_RACE_COURSE_OPTIONS, ...options };
    const surface = opts.surface;
    const centerline = buildCenterline(opts.waypoints, opts.closed, opts.subdivisions);
    const n = centerline.length;

    const group = new THREE.Group();
    group.name = 'BoatRaceCourse';

    // ---- centreline tangents + cumulative length ----
    const tangents: THREE.Vector3[] = [];
    const cumulative: number[] = [0];
    for (let i = 0; i < n; i++) {
        const prev = centerline[(i - 1 + n) % n]!;
        const next = centerline[(i + 1) % n]!;
        const t = new THREE.Vector3().subVectors(next, prev);
        t.y = 0;
        if (t.lengthSq() < 1e-8) t.set(0, 0, 1);
        tangents.push(t.normalize());
        if (i > 0) cumulative.push(cumulative[i - 1]! + centerline[i]!.distanceTo(centerline[i - 1]!));
    }
    const totalLength = cumulative[n - 1]!
        + (opts.closed ? centerline[0]!.distanceTo(centerline[n - 1]!) : 0);

    // ---- ribbon ----
    // Four columns per cross-section: outer-left, inner-left, inner-right,
    // outer-right. The outer pair carries the bright edge colour and the inner
    // pair the pale fill, so the interpolation between them paints the lane
    // line without needing a custom shader or a texture.
    const COLUMNS = 4;
    const columnOffsets = [
        -opts.halfWidth,
        -opts.halfWidth + opts.edgeWidth,
        opts.halfWidth - opts.edgeWidth,
        opts.halfWidth,
    ];
    const ribbonRows = opts.closed ? n + 1 : n;
    const ribbonPositions = new Float32Array(ribbonRows * COLUMNS * 3);
    const ribbonColors = new Float32Array(ribbonRows * COLUMNS * 3);
    const edgeColor = new THREE.Color(opts.ribbonEdgeColor);
    const fillColor = new THREE.Color(opts.ribbonColor);
    for (let r = 0; r < ribbonRows; r++) {
        for (let c = 0; c < COLUMNS; c++) {
            const col = (c === 0 || c === COLUMNS - 1) ? edgeColor : fillColor;
            const o = (r * COLUMNS + c) * 3;
            ribbonColors[o] = col.r;
            ribbonColors[o + 1] = col.g;
            ribbonColors[o + 2] = col.b;
        }
    }
    const ribbonIndices = new Uint32Array((ribbonRows - 1) * (COLUMNS - 1) * 6);
    {
        let i = 0;
        for (let r = 0; r < ribbonRows - 1; r++) {
            for (let c = 0; c < COLUMNS - 1; c++) {
                const a = r * COLUMNS + c;
                const b = a + 1;
                const cc = a + COLUMNS;
                const dd = cc + 1;
                ribbonIndices[i++] = a; ribbonIndices[i++] = cc; ribbonIndices[i++] = b;
                ribbonIndices[i++] = b; ribbonIndices[i++] = cc; ribbonIndices[i++] = dd;
            }
        }
    }
    const ribbonGeometry = new THREE.BufferGeometry();
    ribbonGeometry.setAttribute('position', new THREE.BufferAttribute(ribbonPositions, 3));
    ribbonGeometry.setAttribute('color', new THREE.BufferAttribute(ribbonColors, 3));
    ribbonGeometry.setIndex(new THREE.BufferAttribute(ribbonIndices, 1));
    ribbonGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const ribbonMaterial = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: opts.ribbonOpacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        // Deliberately NOT additive. Additive over a saturated blue sea blows
        // straight to white-cyan wherever the ribbon fills the lower frame,
        // which is exactly where the player is looking. A plain alpha tint
        // keeps the water's own tone visible through the lane.
    });
    const ribbon = new THREE.Mesh(ribbonGeometry, ribbonMaterial);
    ribbon.name = 'CourseRibbon';
    ribbon.frustumCulled = false;
    ribbon.renderOrder = 5;
    group.add(ribbon);

    // ---- gates ----
    const buoyParts = buildBuoyParts();
    const capMaterial = new THREE.MeshLambertMaterial({ color: opts.buoyColor });
    const postMaterial = new THREE.MeshLambertMaterial({ color: opts.buoyPostColor });
    const gates: CourseGate[] = [];
    const gateBuoys: THREE.Group[] = [];
    const gateStride = opts.gateCount > 0 ? n / opts.gateCount : 0;
    for (let gi = 0; gi < opts.gateCount; gi++) {
        const idx = Math.round(gi * gateStride) % n;
        const center = centerline[idx]!.clone();
        const forward = tangents[idx]!.clone();
        const across = new THREE.Vector3(forward.z, 0, -forward.x);
        gates.push({ center, forward, across, halfWidth: opts.gateHalfWidth });
        for (const side of [-1, 1]) {
            const buoy = buildBuoyMesh(buoyParts, capMaterial, postMaterial, 1);
            buoy.position.set(
                center.x + across.x * opts.gateHalfWidth * side,
                0,
                center.z + across.z * opts.gateHalfWidth * side,
            );
            group.add(buoy);
            gateBuoys.push(buoy);
        }
    }

    // ---- scatter buoys (scenery) ----
    const rand = makeRandom(opts.seed);
    const scatterBuoys: THREE.Group[] = [];
    for (let i = 0; i < opts.scatterBuoyCount; i++) {
        const anchor = centerline[Math.floor(rand() * n)]!;
        const a = rand() * Math.PI * 2;
        const r = opts.gateHalfWidth * 2.5 + rand() * opts.scatterRadius;
        const buoy = buildBuoyMesh(buoyParts, capMaterial, postMaterial, 0.8 + rand() * 0.9);
        buoy.position.set(anchor.x + Math.cos(a) * r, 0, anchor.z + Math.sin(a) * r);
        buoy.rotation.y = rand() * Math.PI * 2;
        group.add(buoy);
        scatterBuoys.push(buoy);
    }

    // ---- per-frame surface conform ----
    const normalScratch = new THREE.Vector3();
    const upScratch = new THREE.Vector3(0, 1, 0);
    const quatScratch = new THREE.Quaternion();

    const seatBuoy = (buoy: THREE.Group): void => {
        const { x, z } = buoy.position;
        buoy.position.y = surface.heightAt(x, z);
        surface.normalAt(x, z, normalScratch);
        // Lean with the surface, but only partly: a buoy is weighted and rides
        // more upright than the water it sits on.
        normalScratch.lerp(upScratch, 0.45).normalize();
        quatScratch.setFromUnitVectors(upScratch, normalScratch);
        buoy.quaternion.copy(quatScratch);
    };

    const update = (): void => {
        const pos = ribbonGeometry.getAttribute('position') as THREE.BufferAttribute;
        for (let r = 0; r < ribbonRows; r++) {
            const i = r % n;
            const p = centerline[i]!;
            const t = tangents[i]!;
            for (let c = 0; c < COLUMNS; c++) {
                const off = columnOffsets[c]!;
                const x = p.x + t.z * off;
                const z = p.z - t.x * off;
                pos.setXYZ(r * COLUMNS + c, x, surface.heightAt(x, z) + opts.ribbonLift, z);
            }
        }
        pos.needsUpdate = true;
        for (const b of gateBuoys) seatBuoy(b);
        for (const b of scatterBuoys) seatBuoy(b);
        // Gate centres track the water too, so a crossing test in 3D lines up
        // with what the player sees.
        for (const g of gates) g.center.y = surface.heightAt(g.center.x, g.center.z);
    };
    update();

    const relFrom = new THREE.Vector3();
    const relTo = new THREE.Vector3();

    return {
        group,
        gates,
        centerline,
        length: totalLength,
        update,
        gateCrossed(index: number, from: THREE.Vector3, to: THREE.Vector3): boolean {
            const g = gates[((index % gates.length) + gates.length) % gates.length];
            if (!g) return false;
            relFrom.subVectors(from, g.center);
            relTo.subVectors(to, g.center);
            const dFrom = relFrom.x * g.forward.x + relFrom.z * g.forward.z;
            const dTo = relTo.x * g.forward.x + relTo.z * g.forward.z;
            // Behind the gate last frame, in front of it now — and only that
            // way round, so reversing back through a gate does not re-score it.
            if (!(dFrom < 0 && dTo >= 0)) return false;
            const span = dTo - dFrom;
            const s = span > 1e-6 ? -dFrom / span : 0;
            const crossX = relFrom.x + (relTo.x - relFrom.x) * s;
            const crossZ = relFrom.z + (relTo.z - relFrom.z) * s;
            const lateral = crossX * g.across.x + crossZ * g.across.z;
            return Math.abs(lateral) <= g.halfWidth;
        },
        distanceAlong(point: THREE.Vector3): number {
            let best = 0;
            let bestD2 = Infinity;
            for (let i = 0; i < n; i++) {
                const p = centerline[i]!;
                const dx = p.x - point.x;
                const dz = p.z - point.z;
                const d2 = dx * dx + dz * dz;
                if (d2 < bestD2) { bestD2 = d2; best = i; }
            }
            return cumulative[best] ?? 0;
        },
        dispose(): void {
            group.removeFromParent();
            ribbonGeometry.dispose();
            ribbonMaterial.dispose();
            capMaterial.dispose();
            postMaterial.dispose();
            buoyParts.dispose();
        },
    };
}
