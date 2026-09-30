/**
 * Procedural watercraft hull — the thing the rider stands on. Built from a
 * lofted set of cross-sections so it has a real pointed bow, a chine and a flat
 * planing bottom, rather than a stretched box.
 *
 * Placed in WORLD space beside the player rather than parented to a bone, for
 * the same reason `engine/ski/SkiEquipment.ts` is: the visible character is
 * drawn as separate block parts, so anything parented under the animation
 * skeleton never shows, and the Mixamo foot bone's local axes are not
 * nose-forward anyway. `BoatMovement` owns the transform and drives it every
 * frame.
 *
 * Local frame matches the engine's gameplay convention: +Z is the bow, +Y up,
 * origin at the waterline so `BoatMovement.rideHeight` means what it says.
 *
 * Flat-shaded on purpose — it has to sit next to a posterized ocean without
 * looking like it came from a different renderer.
 */

import * as THREE from 'three';
import type { BoatConfig } from 'engine/boat/BoatConfig.js';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';

/**
 * One station along the hull: its Z, and the section's half-widths and heights.
 * Ordered stern (−Z) to bow (+Z).
 */
interface HullStation {
    z: number;
    /** Half-width at the gunwale (deck edge). */
    deckHalf: number;
    /** Half-width at the chine (where bottom meets topsides). */
    chineHalf: number;
    /** Y of the deck edge. */
    deckY: number;
    /** Y of the chine. */
    chineY: number;
    /** Y of the keel centreline. */
    keelY: number;
}

/** A 3.2 m watercraft: wide amidships, fine at the bow, transom-sterned. */
const STATIONS: readonly HullStation[] = [
    { z: -1.70, deckHalf: 0.50, chineHalf: 0.43, deckY: 0.20, chineY: -0.08, keelY: -0.22 },
    { z: -1.00, deckHalf: 0.56, chineHalf: 0.48, deckY: 0.23, chineY: -0.10, keelY: -0.30 },
    { z: -0.20, deckHalf: 0.58, chineHalf: 0.49, deckY: 0.25, chineY: -0.10, keelY: -0.32 },
    { z: 0.55, deckHalf: 0.53, chineHalf: 0.42, deckY: 0.28, chineY: -0.07, keelY: -0.29 },
    { z: 1.25, deckHalf: 0.42, chineHalf: 0.32, deckY: 0.34, chineY: 0.01, keelY: -0.19 },
    { z: 1.80, deckHalf: 0.26, chineHalf: 0.18, deckY: 0.44, chineY: 0.15, keelY: 0.00 },
    { z: 2.15, deckHalf: 0.07, chineHalf: 0.05, deckY: 0.56, chineY: 0.36, keelY: 0.22 },
];

/**
 * Section points, counter-clockwise seen from the bow looking aft, starting at
 * the keel: keel → port chine → port gunwale → starboard gunwale → starboard
 * chine → back to keel.
 */
function sectionPoints(s: HullStation): THREE.Vector3[] {
    return [
        new THREE.Vector3(0, s.keelY, s.z),
        new THREE.Vector3(-s.chineHalf, s.chineY, s.z),
        new THREE.Vector3(-s.deckHalf, s.deckY, s.z),
        new THREE.Vector3(s.deckHalf, s.deckY, s.z),
        new THREE.Vector3(s.chineHalf, s.chineY, s.z),
    ];
}

/** Loft the stations into a closed hull with a transom cap at the stern. */
function buildHullGeometry(): THREE.BufferGeometry {
    const rings = STATIONS.map(sectionPoints);
    const positions: number[] = [];
    const push = (v: THREE.Vector3): void => { positions.push(v.x, v.y, v.z); };
    const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void => {
        push(a); push(b); push(c);
        push(a); push(c); push(d);
    };

    const K = 5;
    for (let i = 0; i < rings.length - 1; i++) {
        const r0 = rings[i]!;
        const r1 = rings[i + 1]!;
        for (let k = 0; k < K; k++) {
            const k1 = (k + 1) % K;
            quad(r0[k]!, r1[k]!, r1[k1]!, r0[k1]!);
        }
    }
    // Transom: fan the stern section around its centroid.
    const stern = rings[0]!;
    const centre = new THREE.Vector3();
    for (const p of stern) centre.add(p);
    centre.multiplyScalar(1 / stern.length);
    for (let k = 0; k < K; k++) {
        const k1 = (k + 1) % K;
        push(centre); push(stern[k1]!); push(stern[k]!);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    return geometry;
}

/** Deck stripe, seat, handlebars and intake grate — the parts that read as a ski. */
function buildFittings(trim: THREE.Material, seat: THREE.Material, dark: THREE.Material): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];

    const deckPad = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.14, 1.5), trim);
    deckPad.position.set(0, 0.32, 0.18);
    out.push(deckPad);

    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.24, 0.9), seat);
    saddle.position.set(0, 0.44, -0.48);
    out.push(saddle);

    const column = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.46, 0.24), dark);
    column.position.set(0, 0.58, 1.02);
    column.rotation.x = -0.22;
    out.push(column);

    const bars = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.09, 0.11), dark);
    bars.position.set(0, 0.82, 1.06);
    out.push(bars);

    // Tucked inside the transom silhouette: hung further aft it pokes out
    // below the waterline and shows through the trough in front of the boat.
    const grate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.26), dark);
    grate.position.set(0, -0.02, -1.46);
    out.push(grate);

    return out;
}

/**
 * A crouched rider, built from boxes to match the flat-shaded hull. Not
 * animated: at racing speed a rider is a fixed tuck, and a bone-driven
 * character on a 3 m prop costs far more than the silhouette is worth.
 */
function buildRider(suit: THREE.Material, helmet: THREE.Material): THREE.Mesh[] {
    const parts: THREE.Mesh[] = [];
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rx = 0): void => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z);
        m.rotation.x = rx;
        parts.push(m);
    };
    // Rotation about X maps local +Z to (0, −sin θ, cos θ): to angle a
    // forward-pointing arm DOWN toward the handlebars the sign is POSITIVE.
    // Getting that backwards points every limb at the sky, which is exactly
    // what the first version did.
    add(new THREE.BoxGeometry(0.34, 0.26, 0.44), suit, 0, 0.66, -0.34);
    add(new THREE.BoxGeometry(0.38, 0.52, 0.32), suit, 0, 0.94, -0.08, -0.60);
    add(new THREE.BoxGeometry(0.26, 0.25, 0.28), helmet, 0, 1.26, 0.12);
    for (const side of [-1, 1]) {
        // Arms reach forward and down onto the bars at (0, 0.82, 1.06).
        add(new THREE.BoxGeometry(0.10, 0.10, 0.95), suit, side * 0.19, 0.98, 0.56, 0.30);
        // Legs tucked back along the deck.
        add(new THREE.BoxGeometry(0.16, 0.34, 0.16), suit, side * 0.15, 0.50, -0.56, 0.45);
    }
    return parts;
}

export class BoatHull {
    private readonly config: BoatConfig;
    private group: THREE.Group | null = null;
    private materials: THREE.Material[] = [];
    private geometries: THREE.BufferGeometry[] = [];
    private parent: THREE.Object3D | null = null;

    constructor(config: BoatConfig) {
        this.config = config;
    }

    /**
     * Build (once) and place the hull. `position` is the waterline point the
     * hull rides at; `orientation` carries heading plus wave/turn lean.
     * `parent` is the scene node the player is drawn under.
     */
    syncTransform(parent: THREE.Object3D | null, position: THREE.Vector3, orientation: THREE.Quaternion): void {
        if (!this.config.showHull || !parent) return;
        if (!this.group) this.group = this.build();
        if (this.parent !== parent) {
            parent.add(this.group);
            this.parent = parent;
        }
        this.group.position.copy(position);
        this.group.quaternion.copy(orientation);
    }

    private build(): THREE.Group {
        const g = new THREE.Group();
        g.name = 'BoatHull';

        // Material classes with the boat's flat-shaded look kept: painted hull,
        // metal trim, leather seats, matte engine-darks. Low quality renders
        // all of them Lambert — exactly what every slot was before.
        const hullMat = createClassedPartMaterial('paint', { color: this.config.hullColor, flatShading: true });
        const trimMat = createClassedPartMaterial('metal', { color: this.config.trimColor, flatShading: true });
        const seatMat = createClassedPartMaterial('leather', { color: this.config.seatColor, flatShading: true });
        const darkMat = createClassedPartMaterial('matte', { color: 0x1b2230, flatShading: true });
        this.materials.push(hullMat, trimMat, seatMat, darkMat);

        const hullGeo = buildHullGeometry();
        this.geometries.push(hullGeo);
        const hull = new THREE.Mesh(hullGeo, hullMat);
        hull.castShadow = true;
        g.add(hull);

        const fittings = buildFittings(trimMat, seatMat, darkMat);
        if (this.config.showRider) {
            const suitMat = createClassedPartMaterial('cloth', { color: this.config.riderColor, flatShading: true });
            const helmetMat = createClassedPartMaterial('plastic', { color: this.config.riderHelmetColor, flatShading: true });
            this.materials.push(suitMat, helmetMat);
            fittings.push(...buildRider(suitMat, helmetMat));
        }
        for (const part of fittings) {
            this.geometries.push(part.geometry);
            part.castShadow = true;
            g.add(part);
        }

        g.scale.setScalar(this.config.hullScale);
        return g;
    }

    /** Remove from the scene and release GPU resources. */
    detach(): void {
        if (this.group) {
            this.group.removeFromParent();
            this.group = null;
        }
        this.parent = null;
        for (const geo of this.geometries) geo.dispose();
        for (const mat of this.materials) mat.dispose();
        this.geometries = [];
        this.materials = [];
    }
}
