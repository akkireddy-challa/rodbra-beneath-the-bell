/**
 * TelegraphVFX - Reusable combat telegraph and ground effect primitives
 *
 * Provides configurable VFX classes for common combat visuals:
 * - CircleTelegraph: Ring/disc AoE indicator with charge animation
 * - ConeTelegraph: Directional wedge indicator
 * - LineTelegraph: Beam/charge line indicator
 * - GroundZone: Persistent hazard area (fire, poison, void, frost)
 * - OrbEffect: Floating sphere with lifecycle phases
 *
 * All classes follow the update(dt) / isComplete() / dispose() lifecycle.
 */

import * as THREE from 'three';
import { ShaderKeepAlive } from 'engine/effects/ShaderKeepAlive.js';

/**
 * Every ground-facing telegraph layer — fill discs, rings, wedges, beams —
 * is the same additive, non-depth-writing overlay. One configuration means one
 * shader program, which is why they all share `OVERLAY_KEEP_ALIVE_KEY`.
 *
 * Starts fully transparent: each class ramps opacity as it charges.
 */
function createOverlayMaterial(color: THREE.ColorRepresentation): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
    });
}

/**
 * Telegraphs are built per attack and disposed; keeping the overlay program
 * compiled between them avoids a synchronous shader compile on every cast
 * (see ShaderKeepAlive).
 */
const OVERLAY_KEEP_ALIVE_KEY = 'telegraph:additive-overlay';

/** Free every mesh under `group`, then detach it. */
function disposeGroup(scene: THREE.Scene, group: THREE.Group): void {
    group.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        child.geometry.dispose();
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materials) material.dispose();
    });
    scene.remove(group);
}

// ════════════════════════════════════════════════════════════════════════════════
// CircleTelegraph
// ════════════════════════════════════════════════════════════════════════════════

export interface CircleTelegraphConfig {
    radius: number;
    position: THREE.Vector3;
    chargeDuration: number;
    colorStart: number;
    colorEnd: number;
    layers: ('fill' | 'ring' | 'pulse')[];
}

export const DEFAULT_CIRCLE_TELEGRAPH_CONFIG: CircleTelegraphConfig = {
    radius: 1,
    position: new THREE.Vector3(),
    chargeDuration: 1,
    colorStart: 0xffa500,
    colorEnd: 0xff0000,
    layers: ['fill', 'ring', 'pulse'],
};

export class CircleTelegraph {
    private scene: THREE.Scene;
    private group: THREE.Group;
    private elapsed = 0;
    private config: CircleTelegraphConfig;
    private complete = false;
    private triggered = false;
    private triggerElapsed = 0;
    private fillMesh: THREE.Mesh | null = null;
    private ringMesh: THREE.Mesh | null = null;
    private pulseMesh: THREE.Mesh | null = null;
    private fillMat: THREE.MeshBasicMaterial | null = null;
    private ringMat: THREE.MeshBasicMaterial | null = null;
    private pulseMat: THREE.MeshBasicMaterial | null = null;
    private colorStart: THREE.Color;
    private colorEnd: THREE.Color;
    private tempColor = new THREE.Color();

    constructor(scene: THREE.Scene, config: CircleTelegraphConfig) {
        this.scene = scene;
        this.config = config;
        this.colorStart = new THREE.Color(this.config.colorStart);
        this.colorEnd = new THREE.Color(this.config.colorEnd);
        this.group = new THREE.Group();
        this.group.position.copy(this.config.position);
        this.group.rotation.x = -Math.PI / 2; // lay flat
        this.buildLayers();
        scene.add(this.group);
        const anyMat = this.fillMat ?? this.ringMat ?? this.pulseMat;
        if (anyMat) ShaderKeepAlive.for(scene).retain(OVERLAY_KEEP_ALIVE_KEY, anyMat);
    }

    private buildLayers(): void {
        const { radius, layers } = this.config;

        if (layers.includes('fill')) {
            const geo = new THREE.CircleGeometry(radius, 48);
            this.fillMat = createOverlayMaterial(this.colorStart.clone());
            this.fillMesh = new THREE.Mesh(geo, this.fillMat);
            this.group.add(this.fillMesh);
        }
        if (layers.includes('ring')) {
            const geo = new THREE.RingGeometry(radius * 0.92, radius, 48);
            this.ringMat = createOverlayMaterial(this.colorStart.clone());
            this.ringMesh = new THREE.Mesh(geo, this.ringMat);
            this.ringMesh.position.z = 0.01;
            this.group.add(this.ringMesh);
        }
        if (layers.includes('pulse')) {
            const geo = new THREE.RingGeometry(radius * 0.85, radius * 0.88, 48);
            this.pulseMat = createOverlayMaterial(0xffffff);
            this.pulseMesh = new THREE.Mesh(geo, this.pulseMat);
            this.pulseMesh.position.z = 0.02;
            this.group.add(this.pulseMesh);
        }
    }

    update(deltaTime: number): void {
        if (this.complete) return;

        if (this.triggered) {
            this.updateTriggerPhase(deltaTime);
            return;
        }

        this.elapsed += deltaTime;
        const t = Math.min(this.elapsed / this.config.chargeDuration, 1);

        // Color lerp
        this.tempColor.copy(this.colorStart).lerp(this.colorEnd, t);

        // Opacity ramp
        const opacity = t * 0.6;

        if (this.fillMat) {
            this.fillMat.color.copy(this.tempColor);
            this.fillMat.opacity = opacity * 0.4;
        }
        if (this.ringMat) {
            this.ringMat.color.copy(this.tempColor);
            this.ringMat.opacity = opacity;
        }

        // Pulse: frequency ramps from 4Hz to 20Hz
        if (this.pulseMat) {
            const freq = 4 + t * 16;
            const pulse = Math.sin(this.elapsed * freq * Math.PI * 2) * 0.5 + 0.5;
            this.pulseMat.opacity = pulse * opacity * 0.7;
        }

        // Pre-impact spike in last 15%
        if (t > 0.85) {
            const spike = (t - 0.85) / 0.15;
            if (this.ringMat) this.ringMat.opacity = Math.min(opacity + spike * 0.4, 1);
            // Slight radius contract
            const scale = 1 - spike * 0.05;
            this.group.scale.set(scale, scale, 1);
        }

        if (this.elapsed >= this.config.chargeDuration) {
            this.trigger();
        }
    }

    trigger(): void {
        if (this.triggered || this.complete) return;
        this.triggered = true;
        this.triggerElapsed = 0;
    }

    private updateTriggerPhase(deltaTime: number): void {
        this.triggerElapsed += deltaTime;
        const impactDuration = 0.3;
        const t = this.triggerElapsed / impactDuration;

        if (t >= 1) {
            this.complete = true;
            return;
        }

        // White flash -> expand ring -> fade
        const flash = 1 - t;
        if (this.fillMat) {
            this.fillMat.color.setHex(0xffffff);
            this.fillMat.opacity = flash * 0.8;
        }
        if (this.ringMat) {
            this.ringMat.color.setHex(0xffffff);
            this.ringMat.opacity = flash;
        }
        if (this.pulseMat) {
            this.pulseMat.opacity = flash * 0.5;
        }
        // Expanding ring
        const scale = 1 + t * 0.3;
        this.group.scale.set(scale, scale, 1);
    }

    isComplete(): boolean {
        return this.complete;
    }

    dispose(): void {
        disposeGroup(this.scene, this.group);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// ConeTelegraph
// ════════════════════════════════════════════════════════════════════════════════

export interface ConeTelegraphConfig {
    angle: number;
    length: number;
    direction: THREE.Vector3;
    position: THREE.Vector3;
    chargeDuration: number;
    colorStart: number;
    colorEnd: number;
}

export const DEFAULT_CONE_TELEGRAPH_CONFIG: ConeTelegraphConfig = {
    angle: Math.PI / 3,
    length: 2,
    direction: new THREE.Vector3(0, 0, 1),
    position: new THREE.Vector3(),
    chargeDuration: 1,
    colorStart: 0xffa500,
    colorEnd: 0xff0000,
};

export class ConeTelegraph {
    private scene: THREE.Scene;
    private group: THREE.Group;
    private elapsed = 0;
    private config: ConeTelegraphConfig;
    private complete = false;
    private triggered = false;
    private triggerElapsed = 0;
    private fanMesh: THREE.Mesh;
    private fanMat: THREE.MeshBasicMaterial;
    private borderMesh: THREE.LineSegments;
    private borderMat: THREE.LineBasicMaterial;
    private colorStart: THREE.Color;
    private colorEnd: THREE.Color;
    private tempColor = new THREE.Color();

    constructor(scene: THREE.Scene, config: ConeTelegraphConfig) {
        this.scene = scene;
        this.config = config;
        this.colorStart = new THREE.Color(this.config.colorStart);
        this.colorEnd = new THREE.Color(this.config.colorEnd);
        this.group = new THREE.Group();
        this.group.position.copy(this.config.position);
        this.group.position.y += 0.05; // slight lift off ground

        // Orient group to face direction (on XZ plane)
        const dir = this.config.direction.clone().normalize();
        const yaw = Math.atan2(dir.x, dir.z);
        this.group.rotation.y = yaw;

        const { fanGeo, borderGeo } = this.buildFanGeometry();
        this.fanMat = createOverlayMaterial(this.colorStart.clone());
        this.fanMesh = new THREE.Mesh(fanGeo, this.fanMat);
        this.fanMesh.rotation.x = -Math.PI / 2;
        this.group.add(this.fanMesh);

        this.borderMat = new THREE.LineBasicMaterial({
            color: this.colorStart.clone(),
            transparent: true,
            opacity: 0,
        });
        this.borderMesh = new THREE.LineSegments(borderGeo, this.borderMat);
        this.borderMesh.rotation.x = -Math.PI / 2;
        this.group.add(this.borderMesh);

        scene.add(this.group);
        const keep = ShaderKeepAlive.for(scene);
        keep.retain(OVERLAY_KEEP_ALIVE_KEY, this.fanMat);
        keep.retain('telegraph:line', this.borderMat, 'line');
    }

    private buildFanGeometry(): { fanGeo: THREE.BufferGeometry; borderGeo: THREE.BufferGeometry } {
        const { angle, length } = this.config;
        const segments = 24;
        const halfAngle = angle / 2;

        // Fan triangles from origin
        const positions: number[] = [];
        for (let i = 0; i < segments; i++) {
            const a0 = -halfAngle + (angle * i) / segments;
            const a1 = -halfAngle + (angle * (i + 1)) / segments;
            // origin
            positions.push(0, 0, 0);
            // edge point 1
            positions.push(Math.sin(a0) * length, Math.cos(a0) * length, 0);
            // edge point 2
            positions.push(Math.sin(a1) * length, Math.cos(a1) * length, 0);
        }

        const fanGeo = new THREE.BufferGeometry();
        fanGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        fanGeo.computeVertexNormals();

        // Border: two radial lines + arc
        const borderPositions: number[] = [];
        // Left edge
        borderPositions.push(0, 0, 0);
        borderPositions.push(Math.sin(-halfAngle) * length, Math.cos(-halfAngle) * length, 0);
        // Right edge
        borderPositions.push(0, 0, 0);
        borderPositions.push(Math.sin(halfAngle) * length, Math.cos(halfAngle) * length, 0);
        // Arc
        for (let i = 0; i < segments; i++) {
            const a0 = -halfAngle + (angle * i) / segments;
            const a1 = -halfAngle + (angle * (i + 1)) / segments;
            borderPositions.push(Math.sin(a0) * length, Math.cos(a0) * length, 0);
            borderPositions.push(Math.sin(a1) * length, Math.cos(a1) * length, 0);
        }

        const borderGeo = new THREE.BufferGeometry();
        borderGeo.setAttribute('position', new THREE.Float32BufferAttribute(borderPositions, 3));

        return { fanGeo, borderGeo };
    }

    update(deltaTime: number): void {
        if (this.complete) return;

        if (this.triggered) {
            this.updateTriggerPhase(deltaTime);
            return;
        }

        this.elapsed += deltaTime;
        const t = Math.min(this.elapsed / this.config.chargeDuration, 1);

        this.tempColor.copy(this.colorStart).lerp(this.colorEnd, t);
        const opacity = t * 0.5;

        this.fanMat.color.copy(this.tempColor);
        this.fanMat.opacity = opacity * 0.4;
        this.borderMat.color.copy(this.tempColor);
        this.borderMat.opacity = opacity;

        // Sweep fill: scale from center outward
        const fillScale = 0.3 + t * 0.7;
        this.fanMesh.scale.set(fillScale, fillScale, 1);

        if (this.elapsed >= this.config.chargeDuration) {
            this.trigger();
        }
    }

    trigger(): void {
        if (this.triggered || this.complete) return;
        this.triggered = true;
        this.triggerElapsed = 0;
    }

    private updateTriggerPhase(deltaTime: number): void {
        this.triggerElapsed += deltaTime;
        const impactDuration = 0.25;
        const t = this.triggerElapsed / impactDuration;

        if (t >= 1) {
            this.complete = true;
            return;
        }

        const flash = 1 - t;
        this.fanMat.color.setHex(0xffffff);
        this.fanMat.opacity = flash * 0.7;
        this.borderMat.color.setHex(0xffffff);
        this.borderMat.opacity = flash;
        this.fanMesh.scale.set(1, 1, 1);
    }

    isComplete(): boolean {
        return this.complete;
    }

    dispose(): void {
        this.fanMesh.geometry.dispose();
        this.fanMat.dispose();
        this.borderMesh.geometry.dispose();
        this.borderMat.dispose();
        this.scene.remove(this.group);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// LineTelegraph
// ════════════════════════════════════════════════════════════════════════════════

export interface LineTelegraphConfig {
    width: number;
    length: number;
    direction: THREE.Vector3;
    position: THREE.Vector3;
    chargeDuration: number;
    colorStart: number;
    colorEnd: number;
}

export const DEFAULT_LINE_TELEGRAPH_CONFIG: LineTelegraphConfig = {
    width: 0.5,
    length: 5,
    direction: new THREE.Vector3(0, 0, 1),
    position: new THREE.Vector3(),
    chargeDuration: 1,
    colorStart: 0xffa500,
    colorEnd: 0xff0000,
};

export class LineTelegraph {
    private scene: THREE.Scene;
    private group: THREE.Group;
    private elapsed = 0;
    private config: LineTelegraphConfig;
    private complete = false;
    private triggered = false;
    private triggerElapsed = 0;
    private planeMesh: THREE.Mesh;
    private planeMat: THREE.MeshBasicMaterial;
    private planeGeo: THREE.PlaneGeometry;
    private colorStart: THREE.Color;
    private colorEnd: THREE.Color;
    private tempColor = new THREE.Color();
    private totalVertices: number;

    constructor(scene: THREE.Scene, config: LineTelegraphConfig) {
        this.scene = scene;
        this.config = config;
        this.colorStart = new THREE.Color(this.config.colorStart);
        this.colorEnd = new THREE.Color(this.config.colorEnd);

        this.group = new THREE.Group();
        this.group.position.copy(this.config.position);
        this.group.position.y += 0.05;

        // Orient along direction (XZ plane)
        const dir = this.config.direction.clone().normalize();
        const yaw = Math.atan2(dir.x, dir.z);
        this.group.rotation.y = yaw;

        // Plane centered along +Z direction, lying flat on ground
        this.planeGeo = new THREE.PlaneGeometry(this.config.width, this.config.length, 1, 10);
        this.planeMat = createOverlayMaterial(this.colorStart.clone());
        this.planeMesh = new THREE.Mesh(this.planeGeo, this.planeMat);
        this.planeMesh.rotation.x = -Math.PI / 2;
        // Offset so start is at origin, end extends along +Y in local (which is +Z after rotation)
        this.planeMesh.position.z = this.config.length / 2;
        this.group.add(this.planeMesh);
        ShaderKeepAlive.for(scene).retain(OVERLAY_KEEP_ALIVE_KEY, this.planeMat);

        // Store total vertex count for drawRange
        const indexAttr = this.planeGeo.getIndex();
        this.totalVertices = indexAttr ? indexAttr.count : this.planeGeo.getAttribute('position').count;

        // Start hidden
        this.planeGeo.setDrawRange(0, 0);

        scene.add(this.group);
    }

    update(deltaTime: number): void {
        if (this.complete) return;

        if (this.triggered) {
            this.updateTriggerPhase(deltaTime);
            return;
        }

        this.elapsed += deltaTime;
        const t = Math.min(this.elapsed / this.config.chargeDuration, 1);

        this.tempColor.copy(this.colorStart).lerp(this.colorEnd, t);
        this.planeMat.color.copy(this.tempColor);
        this.planeMat.opacity = t * 0.5;

        // Reveal progressively via drawRange
        const revealed = Math.floor(t * this.totalVertices);
        this.planeGeo.setDrawRange(0, revealed);

        if (this.elapsed >= this.config.chargeDuration) {
            this.trigger();
        }
    }

    trigger(): void {
        if (this.triggered || this.complete) return;
        this.triggered = true;
        this.triggerElapsed = 0;
        // Show full geometry
        this.planeGeo.setDrawRange(0, this.totalVertices);
    }

    private updateTriggerPhase(deltaTime: number): void {
        this.triggerElapsed += deltaTime;
        const impactDuration = 0.25;
        const t = this.triggerElapsed / impactDuration;

        if (t >= 1) {
            this.complete = true;
            return;
        }

        const flash = 1 - t;
        this.planeMat.color.setHex(0xffffff);
        this.planeMat.opacity = flash * 0.8;
    }

    isComplete(): boolean {
        return this.complete;
    }

    dispose(): void {
        this.planeGeo.dispose();
        this.planeMat.dispose();
        this.scene.remove(this.group);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// GroundZone
// ════════════════════════════════════════════════════════════════════════════════

export const ZONE_THEME_COLORS: Record<'fire' | 'poison' | 'void' | 'frost', number> = {
    fire: 0xff4400,
    poison: 0x44ff00,
    void: 0x8800ff,
    frost: 0x00ccff,
};

export interface GroundZoneConfig {
    radius: number;
    position: THREE.Vector3;
    zoneType: 'fire' | 'poison' | 'void' | 'frost' | 'custom';
    color: number;
    duration: number;
    fadeInTime: number;
    fadeOutTime: number;
}

export const DEFAULT_GROUND_ZONE_CONFIG: GroundZoneConfig = {
    radius: 1,
    position: new THREE.Vector3(),
    zoneType: 'fire',
    color: ZONE_THEME_COLORS.fire,
    duration: 5,
    fadeInTime: 0.35,
    fadeOutTime: 0.5,
};

type GroundZonePhase = 'spawn' | 'active' | 'despawn';

export class GroundZone {
    private scene: THREE.Scene;
    private group: THREE.Group;
    private elapsed = 0;
    private config: GroundZoneConfig;
    private complete = false;
    private phase: GroundZonePhase = 'spawn';
    private fillMesh: THREE.Mesh;
    private fillMat: THREE.MeshBasicMaterial;
    private borderMesh: THREE.Mesh;
    private borderMat: THREE.MeshBasicMaterial;
    private shimmerMesh: THREE.Mesh;
    private shimmerMat: THREE.MeshBasicMaterial;
    private zoneColor: THREE.Color;

    constructor(scene: THREE.Scene, config: GroundZoneConfig) {
        this.scene = scene;
        this.config = config;
        this.zoneColor = new THREE.Color(this.config.color);

        this.group = new THREE.Group();
        this.group.position.copy(this.config.position);
        this.group.position.y += 0.05;
        this.group.rotation.x = -Math.PI / 2;

        // Fill disc
        const fillGeo = new THREE.CircleGeometry(this.config.radius, 48);
        this.fillMat = createOverlayMaterial(this.zoneColor.clone());
        this.fillMesh = new THREE.Mesh(fillGeo, this.fillMat);
        this.group.add(this.fillMesh);

        // Border ring
        const borderGeo = new THREE.RingGeometry(this.config.radius * 0.94, this.config.radius, 48);
        this.borderMat = createOverlayMaterial(this.zoneColor.clone());
        this.borderMesh = new THREE.Mesh(borderGeo, this.borderMat);
        this.borderMesh.position.z = 0.01;
        this.group.add(this.borderMesh);

        // Shimmer ring (rotating)
        const shimmerGeo = new THREE.RingGeometry(this.config.radius * 0.5, this.config.radius * 0.55, 48, 1, 0, Math.PI);
        this.shimmerMat = createOverlayMaterial(0xffffff);
        this.shimmerMesh = new THREE.Mesh(shimmerGeo, this.shimmerMat);
        this.shimmerMesh.position.z = 0.02;
        this.group.add(this.shimmerMesh);
        ShaderKeepAlive.for(scene).retain(OVERLAY_KEEP_ALIVE_KEY, this.fillMat);

        // Start at scale 0 for spawn animation
        this.group.scale.set(0, 0, 1);

        scene.add(this.group);
    }

    update(deltaTime: number): void {
        if (this.complete) return;
        this.elapsed += deltaTime;

        switch (this.phase) {
            case 'spawn':
                this.updateSpawn();
                break;
            case 'active':
                this.updateActive(deltaTime);
                break;
            case 'despawn':
                this.updateDespawn();
                break;
        }
    }

    private updateSpawn(): void {
        const t = Math.min(this.elapsed / this.config.fadeInTime, 1);
        // easeOutBack: overshoot then settle
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const scale = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
        this.group.scale.set(scale, scale, 1);

        this.fillMat.opacity = t * 0.3;
        this.borderMat.opacity = t * 0.7;
        this.shimmerMat.opacity = t * 0.2;

        if (t >= 1) {
            this.phase = 'active';
        }
    }

    private updateActive(deltaTime: number): void {
        const activeEnd = this.config.fadeInTime + this.config.duration;
        if (this.elapsed >= activeEnd) {
            this.phase = 'despawn';
            return;
        }

        // Shimmer rotation
        this.shimmerMesh.rotation.z += deltaTime * 2;

        // Border glow pulse
        const pulse = Math.sin(this.elapsed * 3) * 0.15 + 0.7;
        this.borderMat.opacity = pulse;
        this.fillMat.opacity = 0.3;
        this.shimmerMat.opacity = 0.2 + Math.sin(this.elapsed * 5) * 0.1;
    }

    private updateDespawn(): void {
        const despawnStart = this.config.fadeInTime + this.config.duration;
        const t = Math.min((this.elapsed - despawnStart) / this.config.fadeOutTime, 1);

        const fade = 1 - t;
        this.fillMat.opacity = 0.3 * fade;
        this.borderMat.opacity = 0.7 * fade;
        this.shimmerMat.opacity = 0.2 * fade;
        this.group.scale.set(fade, fade, 1);

        if (t >= 1) {
            this.complete = true;
        }
    }

    isComplete(): boolean {
        return this.complete;
    }

    dispose(): void {
        disposeGroup(this.scene, this.group);
    }
}

// ════════════════════════════════════════════════════════════════════════════════
// OrbEffect
// ════════════════════════════════════════════════════════════════════════════════

export const ORB_TYPE_COLORS: Record<'damage' | 'buff' | 'delayed' | 'moving', number> = {
    damage: 0xff2200,
    buff: 0x22ff88,
    delayed: 0xff8800,
    moving: 0x4488ff,
};

export interface OrbEffectConfig {
    position: THREE.Vector3;
    orbType: 'damage' | 'buff' | 'delayed' | 'moving';
    color: number;
    radius: number;
    lifetime: number;
    auraRadius: number;
}

export const DEFAULT_ORB_EFFECT_CONFIG: OrbEffectConfig = {
    position: new THREE.Vector3(),
    orbType: 'damage',
    color: ORB_TYPE_COLORS.damage,
    radius: 0.3,
    lifetime: 5,
    auraRadius: 0.9,
};

type OrbPhase = 'spawn' | 'idle' | 'ramp' | 'resolve';

export class OrbEffect {
    private scene: THREE.Scene;
    private group: THREE.Group;
    private elapsed = 0;
    private config: OrbEffectConfig;
    private complete = false;
    private phase: OrbPhase = 'spawn';
    private coreMesh: THREE.Mesh;
    private coreMat: THREE.MeshBasicMaterial;
    private auraMesh: THREE.Mesh;
    private auraMat: THREE.MeshBasicMaterial;
    private orbitParticles: THREE.Group;
    private orbColor: THREE.Color;
    private target: THREE.Vector3 | null = null;
    private readonly targetDirection = new THREE.Vector3();
    private resolveElapsed = 0;
    // Tracks the orb's drifting position (without sine-wave Y wobble) so moving-type
    // orbs can travel toward a target on Y as well as XZ. group.position is recomputed
    // each frame from this base + wobble.
    private basePosition: THREE.Vector3;

    constructor(scene: THREE.Scene, config: OrbEffectConfig) {
        this.scene = scene;
        this.config = config;
        this.orbColor = new THREE.Color(this.config.color);

        this.group = new THREE.Group();
        this.group.position.copy(this.config.position);
        this.basePosition = this.config.position.clone();

        // Core sphere
        const coreGeo = new THREE.SphereGeometry(this.config.radius, 16, 16);
        this.coreMat = new THREE.MeshBasicMaterial({
            color: this.orbColor.clone(),
            transparent: true,
            opacity: 0,
        });
        this.coreMesh = new THREE.Mesh(coreGeo, this.coreMat);
        this.group.add(this.coreMesh);

        // Aura sphere
        const auraGeo = new THREE.SphereGeometry(this.config.auraRadius, 16, 16);
        this.auraMat = new THREE.MeshBasicMaterial({
            color: this.orbColor.clone(),
            transparent: true,
            opacity: 0,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
        });
        this.auraMesh = new THREE.Mesh(auraGeo, this.auraMat);
        this.group.add(this.auraMesh);

        // Orbiting particles (small cubes)
        this.orbitParticles = new THREE.Group();
        const particleMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
        const particleGeo = new THREE.BoxGeometry(this.config.radius * 0.2, this.config.radius * 0.2, this.config.radius * 0.2);
        for (let i = 0; i < 6; i++) {
            const p = new THREE.Mesh(particleGeo, particleMat.clone());
            const angle = (i / 6) * Math.PI * 2;
            const orbitR = this.config.auraRadius * 0.6;
            p.position.set(Math.cos(angle) * orbitR, 0, Math.sin(angle) * orbitR);
            this.orbitParticles.add(p);
        }
        this.group.add(this.orbitParticles);
        const keep = ShaderKeepAlive.for(scene);
        keep.retain('telegraph:orb-core', this.coreMat);
        keep.retain('telegraph:orb-aura', this.auraMat);

        // Start small for spawn pulse
        this.group.scale.set(0.01, 0.01, 0.01);

        scene.add(this.group);
    }

    setTarget(pos: THREE.Vector3): void {
        this.target = pos.clone();
    }

    update(deltaTime: number): void {
        if (this.complete) return;
        this.elapsed += deltaTime;

        switch (this.phase) {
            case 'spawn':
                this.updateSpawn();
                break;
            case 'idle':
                this.updateIdle(deltaTime);
                break;
            case 'ramp':
                this.updateRamp(deltaTime);
                break;
            case 'resolve':
                this.updateResolve(deltaTime);
                break;
        }
    }

    private updateSpawn(): void {
        const spawnDuration = 0.3;
        const t = Math.min(this.elapsed / spawnDuration, 1);
        // Pop-in with overshoot
        const scale = t < 0.7 ? t / 0.7 * 1.2 : 1.2 - (t - 0.7) / 0.3 * 0.2;
        this.group.scale.set(scale, scale, scale);

        this.coreMat.opacity = t;
        this.auraMat.opacity = t * 0.15;
        this.setOrbitOpacity(t * 0.6);

        if (t >= 1) {
            this.phase = 'idle';
        }
    }

    private updateIdle(deltaTime: number): void {
        const rampStart = this.config.lifetime * 0.7;
        if (this.elapsed >= rampStart) {
            this.phase = 'ramp';
            return;
        }

        this.driftAndWobble(deltaTime, 3);

        this.coreMesh.rotation.y += deltaTime * 1.5;
        this.orbitParticles.rotation.y += deltaTime * 2;

        // Aura pulse
        this.auraMat.opacity = 0.1 + Math.sin(this.elapsed * 3) * 0.05;
    }

    private updateRamp(deltaTime: number): void {
        if (this.elapsed >= this.config.lifetime) {
            this.phase = 'resolve';
            this.resolveElapsed = 0;
            return;
        }

        const rampStart = this.config.lifetime * 0.7;
        const t = (this.elapsed - rampStart) / (this.config.lifetime - rampStart);

        this.driftAndWobble(deltaTime, 3 + t * 5);

        // Intensity ramp: pulse faster, glow brighter
        const pulse = Math.sin(this.elapsed * (5 + t * 15)) * 0.5 + 0.5;
        this.coreMat.opacity = 0.8 + t * 0.2;
        this.auraMat.opacity = 0.15 + t * 0.2 + pulse * 0.1;
        this.orbitParticles.rotation.y += deltaTime * (2 + t * 6);

        // Scale up slightly
        const scale = 1 + t * 0.15;
        this.group.scale.set(scale, scale, scale);
    }

    private updateResolve(deltaTime: number): void {
        this.resolveElapsed += deltaTime;
        const resolveDuration = 0.35;
        const t = this.resolveElapsed / resolveDuration;

        if (t >= 1) {
            this.complete = true;
            return;
        }

        // Explosion/collect burst
        const flash = 1 - t;
        const scale = 1 + t * 2;
        this.group.scale.set(scale, scale, scale);
        this.coreMat.color.setHex(0xffffff);
        this.coreMat.opacity = flash;
        this.auraMat.opacity = flash * 0.4;
        this.setOrbitOpacity(flash * 0.5);
    }

    /**
     * Creep `basePosition` toward the target at `speed` (moving orbs only),
     * then place the group there plus a sine-wave Y bob. Shared by the idle and
     * ramp phases, which differ only in how fast the orb closes in.
     */
    private driftAndWobble(deltaTime: number, speed: number): void {
        if (this.target && this.config.orbType === 'moving') {
            const dir = this.targetDirection.subVectors(this.target, this.basePosition);
            if (dir.length() > 0.1) {
                this.basePosition.addScaledVector(dir.normalize(), deltaTime * speed);
            }
        }

        this.group.position.set(
            this.basePosition.x,
            this.basePosition.y + Math.sin(this.elapsed * 2) * 0.15,
            this.basePosition.z,
        );
    }

    private setOrbitOpacity(opacity: number): void {
        for (const child of this.orbitParticles.children) {
            if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
                child.material.opacity = opacity;
            }
        }
    }

    isComplete(): boolean {
        return this.complete;
    }

    dispose(): void {
        disposeGroup(this.scene, this.group);
    }
}
