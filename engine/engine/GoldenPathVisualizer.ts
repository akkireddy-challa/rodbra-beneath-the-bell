import * as THREE from 'three';
import type { EngineLike } from 'types/game.js';
import { findForgedFeature } from 'engine/ForgedLevelData.js';

/**
 * Debug overlay that draws the forger's "GOLDEN PATH" — the `spine` gameplay feature a
 * platformer-journey level carries — as a bright line with numbered waypoints through the world,
 * so the INTENDED route from spawn to goal is visible. The spine is otherwise invisible data
 * (`worldForgerFeatures` on the level asset). Toggle with F7 in development (see DebugController).
 *
 * Drawn with depthTest off so the path shows THROUGH terrain — it is a wayfinding aid, not scenery.
 */

interface Vec3Lit { x: number; y: number; z: number }

const PATH_COLOR = 0xffd54a;   // gold
const START_COLOR = 0x39d353;  // green
const GOAL_COLOR = 0xff5a5a;   // red
const LIFT = 2;                // draw slightly above the surface
const POST_HEIGHT = 14;        // vertical post at each waypoint so it's findable from afar

/** Shared by every material here: draw THROUGH the world, never occluded by it. */
const OVERLAY_MATERIAL = { depthTest: false, transparent: true, opacity: 0.95 } as const;

export class GoldenPathVisualizer {
    private engine: EngineLike;
    private group: THREE.Group | null = null;
    private shown = false;

    constructor(engine: EngineLike) {
        this.engine = engine;
    }

    /** Build on first use, then flip visibility. Logs if the level has no spine. */
    toggle(): void {
        if (!this.group) this.build();
        if (!this.group) {
            console.warn('[GoldenPath] no `spine` feature on this level — it is not a forged platformer journey.');
            return;
        }
        this.shown = !this.shown;
        this.group.visible = this.shown;
        console.log(`[GoldenPath] ${this.shown ? 'shown' : 'hidden'} (F7 to toggle)`);
    }

    private findSpinePoints(): Vec3Lit[] | null {
        const spine = findForgedFeature(this.engine.getGameData?.(), { kind: 'spine' });
        return spine?.points && spine.points.length >= 2 ? spine.points : null;
    }

    private overlayLine(points: THREE.Vector3[], color: number): THREE.Line {
        const line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({ color, ...OVERLAY_MATERIAL }),
        );
        line.renderOrder = 999;
        return line;
    }

    private build(): void {
        const pts = this.findSpinePoints();
        if (!pts || !this.engine.scene) return;

        const group = new THREE.Group();
        group.name = 'GoldenPathDebug';
        const lifted = pts.map((p) => new THREE.Vector3(p.x, p.y + LIFT, p.z));

        group.add(this.overlayLine(lifted, PATH_COLOR));

        pts.forEach((p, i) => {
            const color = i === 0 ? START_COLOR : i === pts.length - 1 ? GOAL_COLOR : PATH_COLOR;
            const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(1.8, 12, 12),
                new THREE.MeshBasicMaterial({ color, ...OVERLAY_MATERIAL }),
            );
            sphere.position.copy(lifted[i]!);
            sphere.renderOrder = 1000;
            group.add(sphere);
            // A tall thin post so each waypoint (and its order along the route) is visible from a distance.
            group.add(this.overlayLine([
                new THREE.Vector3(p.x, p.y, p.z),
                new THREE.Vector3(p.x, p.y + POST_HEIGHT, p.z),
            ], color));
        });

        group.visible = false;
        this.engine.scene.add(group);
        this.group = group;
        console.log(`[GoldenPath] built — ${pts.length} waypoints (green = spawn, red = goal).`);
    }

    dispose(): void {
        if (this.group && this.engine.scene) this.engine.scene.remove(this.group);
        this.group?.traverse((obj) => {
            // Lines and meshes alike — read the two fields both carry, without
            // pretending every node is a Mesh.
            const drawable = obj as Partial<THREE.Mesh>;
            drawable.geometry?.dispose();
            const mat = drawable.material;
            if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
        });
        this.group = null;
    }
}
