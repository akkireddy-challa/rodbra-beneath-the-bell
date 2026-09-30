import * as THREE from 'three';

/**
 * Procedural animation controller for voxel-block snakes.
 *
 * Moving: Body segments follow a trail of the head's world-space positions.
 * The trail captures the head's actual path through the world — over cliffs,
 * up walls, around obstacles — so the body naturally follows every surface
 * the head traversed.
 *
 * Idle: Segments gradually coil into a spiral near the head (on flat ground)
 * or remain at their last trail positions (on rough terrain).
 *
 * The controller finds segments by name convention:
 *   SnakeHead, SnakeSegment_0 … SnakeSegment_N, SnakeTail, SnakeTongue
 */

export enum SnakeAnimationState {
    IDLE = 'idle',
    SLITHER = 'slither',
    FAST = 'fast',
}

/** Ground sampling callback for terrain conforming (idle animation only) */
export interface SnakeTerrainConformOptions {
    sampleGroundY: (worldX: number, worldZ: number) => number | null;
}

export interface WaveParams {
    amplitude: number;
    frequency: number;
    speed: number;
}

/** Snapshot of the snake's body part references. */
export interface SnakeBodyParts {
    head: THREE.Object3D | null;
    segments: THREE.Object3D[];
    tail: THREE.Object3D | null;
    tongue: THREE.Object3D | null;
}

export class SnakeAnimationController {
    private root: THREE.Object3D | null = null;
    private head: THREE.Object3D | null = null;
    private tail: THREE.Object3D | null = null;
    private tongue: THREE.Object3D | null = null;
    private segments: THREE.Object3D[] = [];

    private restPositions: THREE.Vector3[] = [];
    private headRestPos = new THREE.Vector3();
    private tailRestPos = new THREE.Vector3();

    private segmentDistances: number[] = [];
    private tailDistance = 0;

    // Trail: world-space positions recording the head's path.
    // trail[0] is the most recent (head), trail[N] is oldest (toward tail).
    private trail: THREE.Vector3[] = [];
    private trailCumulDist: number[] = [];
    private trailSeeded = false;

    // Coiling idle state: world-space positions for each body part
    private idlePositions: THREE.Vector3[] = [];
    private coilTargets: THREE.Vector3[] = [];
    private isCoiling = false;
    private coilFacingAngle = 0;
    private needsInitialCoil = true;

    private waveTime = 0;
    private tongueTime = 0;
    private currentState = SnakeAnimationState.IDLE;
    private isInitialized = false;
    private isMoving = false;

    private originalTransforms: Map<THREE.Object3D, {
        position: THREE.Vector3;
        rotation: THREE.Euler;
        scale: THREE.Vector3;
    }> = new Map();

    private readonly waveParams: Record<SnakeAnimationState, WaveParams> = {
        [SnakeAnimationState.IDLE]: { amplitude: 0.025, frequency: 1.2, speed: 1.0 },
        [SnakeAnimationState.SLITHER]: { amplitude: 0.08, frequency: 2.0, speed: 3.5 },
        [SnakeAnimationState.FAST]: { amplitude: 0.12, frequency: 2.5, speed: 5.5 },
    };

    private readonly tongueFlickInterval = 3.0;
    private readonly tongueFlickDuration = 0.4;
    private tongueFlickTimer = 0;
    private isTongueFlicking = false;

    private readonly _samplePos = new THREE.Vector3();
    private readonly _sampleTangent = new THREE.Vector3();
    private readonly _perpendicular = new THREE.Vector3();
    private readonly _localTangent = new THREE.Vector3();
    private readonly _headWorldPos = new THREE.Vector3();
    private readonly _invQuat = new THREE.Quaternion();
    private readonly _seedDir = new THREE.Vector3();
    private readonly _offLocal = new THREE.Vector3();

    private terrainOptions: SnakeTerrainConformOptions | null = null;

    // ─── PUBLIC API ──────────────────────────────────────────────────

    setTerrainConform(options: SnakeTerrainConformOptions | null): void {
        this.terrainOptions = options;
    }

    // ─── BODY PART ACCESS ───────────────────────────────────────────

    getBodyParts(): SnakeBodyParts {
        return {
            head: this.head,
            segments: [...this.segments],
            tail: this.tail,
            tongue: this.tongue,
        };
    }

    getHead(): THREE.Object3D | null { return this.head; }
    getTail(): THREE.Object3D | null { return this.tail; }
    getTongue(): THREE.Object3D | null { return this.tongue; }
    getSegments(): THREE.Object3D[] { return [...this.segments]; }
    getSegment(index: number): THREE.Object3D | null { return this.segments[index] ?? null; }
    getSegmentCount(): number { return this.segments.length; }

    // ─── WAVE PARAMS ────────────────────────────────────────────────

    setWaveParams(state: SnakeAnimationState, params: Partial<WaveParams>): void {
        const current = this.waveParams[state];
        if (params.amplitude !== undefined) current.amplitude = params.amplitude;
        if (params.frequency !== undefined) current.frequency = params.frequency;
        if (params.speed !== undefined) current.speed = params.speed;
    }

    getWaveParams(state: SnakeAnimationState): Readonly<WaveParams> {
        return this.waveParams[state];
    }

    // ─── RUNTIME LENGTH CHANGE ──────────────────────────────────────

    /**
     * Scale all segment distances proportionally to achieve a new total length.
     * Rest positions and trail are updated; the number of segments stays the same.
     */
    setTotalLength(newLength: number): void {
        if (this.tailDistance <= 0 || newLength <= 0) return;
        const scale = newLength / this.tailDistance;

        for (let i = 0; i < this.segmentDistances.length; i++) {
            this.segmentDistances[i]! *= scale;
        }
        this.tailDistance *= scale;

        for (let i = 0; i < this.restPositions.length; i++) {
            const dz = this.restPositions[i]!.z - this.headRestPos.z;
            this.restPositions[i]!.z = this.headRestPos.z + dz * scale;
        }
        const tailDz = this.tailRestPos.z - this.headRestPos.z;
        this.tailRestPos.z = this.headRestPos.z + tailDz * scale;

        this.resetTrailAndCoil();
    }

    /** Drop the recorded trail and any in-progress coil so both rebuild from scratch. */
    private resetTrailAndCoil(): void {
        this.trail = [];
        this.trailCumulDist = [];
        this.trailSeeded = false;
        this.idlePositions = [];
        this.coilTargets = [];
        this.isCoiling = false;
    }

    async initializeWithCharacter(
        character: THREE.Object3D,
        _gltf: unknown,
        _loader: unknown,
        _baseAnimations: unknown[],
    ): Promise<void> {
        this.root = character;
        this.findParts(character);
        this.storeOriginals();
        this.computeSegmentDistances();
        this.isInitialized = true;
    }

    updateAnimation(
        isMoving: boolean,
        movementSpeed: number,
        _isGrounded: boolean,
        _isJumpPressed: boolean,
    ): void {
        if (!this.isInitialized) return;
        this.isMoving = isMoving && movementSpeed >= 0.1;
        if (!this.isMoving) {
            this.currentState = SnakeAnimationState.IDLE;
        } else if (movementSpeed < 4.0) {
            this.currentState = SnakeAnimationState.SLITHER;
        } else {
            this.currentState = SnakeAnimationState.FAST;
        }
    }

    dispose(): void {
        this.originalTransforms.clear();
        this.segments = [];
        this.segmentDistances = [];
        this.resetTrailAndCoil();
        this.needsInitialCoil = true;
        this.head = null;
        this.tail = null;
        this.tongue = null;
        this.root = null;
        this.terrainOptions = null;
        this.isInitialized = false;
    }

    // ─── CORE UPDATE ─────────────────────────────────────────────────

    update(deltaTime: number): void {
        if (!this.isInitialized || !this.root || !this.head) return;

        const wave = this.waveParams[this.currentState];
        this.waveTime += deltaTime * wave.speed;

        this.root.updateWorldMatrix(true, false);
        this.root.getWorldQuaternion(this._invQuat);
        this._invQuat.invert();

        // Every snake starts coiled — trigger once before the first move/idle split.
        // If the snake immediately starts moving, seedTrailFromIdlePositions() will
        // populate the trail from the coiled shape for a smooth uncoil.
        if (this.needsInitialCoil) {
            this.needsInitialCoil = false;
            this.startInitialCoil();
        }

        if (this.isMoving) {
            if (this.isCoiling) {
                this.seedTrailFromIdlePositions();
                this.isCoiling = false;
            }
            this.recordTrailPoint();
            if (this.trail.length >= 2) {
                this.animateSegmentsFromTrail(wave);
                this.animateTailFromTrail(wave);
            } else {
                this.animateSegmentsIdle(wave, deltaTime);
                this.animateTailIdle(wave, deltaTime);
            }
        } else {
            if (!this.isCoiling && this.trail.length >= 2) {
                this.startCoiling();
            }
            if (this.isCoiling) {
                this.advanceCoil(deltaTime);
                this.placeSegmentsFromIdlePositions(wave);
            } else {
                this.animateSegmentsIdle(wave, deltaTime);
                this.animateTailIdle(wave, deltaTime);
            }
        }

        this.animateHead(wave);
        this.animateTongue(deltaTime);
    }

    // ─── INITIALISATION ─────────────────────────────────────────────────

    private findParts(root: THREE.Object3D): void {
        const segMap = new Map<number, THREE.Object3D>();

        root.traverse((child: THREE.Object3D) => {
            if (child.name === 'SnakeHead') this.head = child;
            else if (child.name === 'SnakeTail') this.tail = child;
            else if (child.name === 'SnakeTongue') this.tongue = child;
            else if (child.name.startsWith('SnakeSegment_')) {
                const idx = parseInt(child.name.split('_')[1]!, 10);
                if (!isNaN(idx)) segMap.set(idx, child);
            }
        });

        const maxIdx = segMap.size > 0 ? Math.max(...segMap.keys()) : -1;
        this.segments = [];
        for (let i = 0; i <= maxIdx; i++) {
            const seg = segMap.get(i);
            if (seg) this.segments.push(seg);
        }

        const parts = [
            this.head && 'head',
            this.segments.length > 0 && `${this.segments.length} segments`,
            this.tail && 'tail',
            this.tongue && 'tongue',
        ].filter(Boolean);
        console.log(`🐍 SnakeAnimationController: Found ${parts.join(', ')}`);
    }

    private storeOriginals(): void {
        const all = [this.head, this.tail, this.tongue, ...this.segments].filter(Boolean) as THREE.Object3D[];
        for (const obj of all) {
            this.originalTransforms.set(obj, {
                position: obj.position.clone(),
                rotation: obj.rotation.clone(),
                scale: obj.scale.clone(),
            });
        }

        this.restPositions = this.segments.map(s => {
            const orig = this.originalTransforms.get(s);
            return orig ? orig.position.clone() : s.position.clone();
        });

        if (this.head) {
            const hOrig = this.originalTransforms.get(this.head);
            this.headRestPos = hOrig ? hOrig.position.clone() : this.head.position.clone();
        }
        if (this.tail) {
            const tOrig = this.originalTransforms.get(this.tail);
            this.tailRestPos = tOrig ? tOrig.position.clone() : this.tail.position.clone();
        }
    }

    private computeSegmentDistances(): void {
        const headZ = this.headRestPos.z;
        this.segmentDistances = this.restPositions.map(rest => Math.abs(headZ - rest.z));
        this.tailDistance = Math.abs(headZ - this.tailRestPos.z);
    }

    // ─── TRAIL SYSTEM ────────────────────────────────────────────────

    private recordTrailPoint(): void {
        if (!this.head || !this.root) return;

        this.head.getWorldPosition(this._headWorldPos);

        if (!this.trailSeeded) {
            this.seedTrail();
            this.trailSeeded = true;
            return;
        }

        const dist = this._headWorldPos.distanceTo(this.trail[0]!);
        if (dist < 0.005) return;

        this.trail.unshift(this._headWorldPos.clone());
        this.recomputeTrailDistances();

        const maxLen = this.tailDistance * 1.5;
        while (this.trail.length > 3 &&
               this.trailCumulDist[this.trail.length - 1]! > maxLen) {
            this.trail.pop();
            this.trailCumulDist.pop();
        }
    }

    private seedTrail(): void {
        if (!this.head || !this.root) return;

        this.head.getWorldPosition(this._headWorldPos);

        const quat = new THREE.Quaternion();
        this.root.getWorldQuaternion(quat);
        this._seedDir.set(0, 0, -1).applyQuaternion(quat);

        const numPoints = Math.max(20, Math.ceil(this.tailDistance / 0.05));
        const stepSize = this.tailDistance / numPoints;

        this.trail = [this._headWorldPos.clone()];
        this.trailCumulDist = [0];

        for (let i = 1; i <= numPoints; i++) {
            const pos = this._headWorldPos.clone().addScaledVector(this._seedDir, stepSize * i);
            this.trail.push(pos);
            this.trailCumulDist.push(stepSize * i);
        }
    }

    private seedTrailFromIdlePositions(): void {
        if (!this.head || !this.root || this.idlePositions.length === 0) {
            this.trailSeeded = false;
            return;
        }

        this.head.getWorldPosition(this._headWorldPos);
        this.trail = [this._headWorldPos.clone()];
        for (const pos of this.idlePositions) {
            this.trail.push(pos.clone());
        }
        this.recomputeTrailDistances();
        this.trailSeeded = true;
    }

    private recomputeTrailDistances(): void {
        this.trailCumulDist = [0];
        for (let i = 1; i < this.trail.length; i++) {
            this.trailCumulDist.push(
                this.trailCumulDist[i - 1]! + this.trail[i]!.distanceTo(this.trail[i - 1]!),
            );
        }
    }

    private sampleTrail(distance: number): { pos: THREE.Vector3; tangent: THREE.Vector3 } | null {
        if (this.trail.length < 2) return null;

        for (let i = 1; i < this.trail.length; i++) {
            if (this.trailCumulDist[i]! >= distance) {
                const prev = this.trailCumulDist[i - 1]!;
                const curr = this.trailCumulDist[i]!;
                const segLen = curr - prev;

                let t = 0;
                if (segLen > 0.0001) t = (distance - prev) / segLen;

                const pos = this.trail[i - 1]!.clone().lerp(this.trail[i]!, t);
                const tangent = new THREE.Vector3().subVectors(this.trail[i - 1]!, this.trail[i]!);
                if (tangent.lengthSq() > 0.0001) tangent.normalize();

                return { pos, tangent };
            }
        }

        const last = this.trail[this.trail.length - 1]!;
        const prev = this.trail[this.trail.length - 2]!;
        const tangent = new THREE.Vector3().subVectors(prev, last);
        if (tangent.lengthSq() > 0.0001) tangent.normalize();
        return { pos: last.clone(), tangent };
    }

    // ─── COILING IDLE SYSTEM ─────────────────────────────────────────

    /** Coil from the recorded trail — used once the snake stops moving. */
    private startCoiling(): void {
        this.beginCoil((_part, distance) => this.sampleTrail(distance)?.pos.clone() ?? new THREE.Vector3());
    }

    /** Coil from current world positions — used before the snake has ever moved. */
    private startInitialCoil(): void {
        if (!this.root || !this.head) return;
        this.beginCoil((part) => part.getWorldPosition(new THREE.Vector3()));
    }

    /**
     * Seed the idle positions for every body part (segments then tail) from
     * `startPosition`, then set up the coil targets they lerp towards.
     */
    private beginCoil(startPosition: (part: THREE.Object3D, distance: number) => THREE.Vector3): void {
        this.idlePositions = this.segments.map((segment, i) => startPosition(segment, this.segmentDistances[i]!));
        if (this.tail) {
            this.idlePositions.push(startPosition(this.tail, this.tailDistance));
        }

        this.coilFacingAngle = this.root?.rotation.y ?? 0;
        // Only coil into a spiral on flat ground; elsewhere the parts stay put.
        const center = this.findCoilCenter();
        this.coilTargets = center && this.isGroundFlat(center)
            ? this.computeCoilTargets(center)
            : [];
        this.isCoiling = true;
    }

    /**
     * Snap to the nearest voxel grid-cell center so the coil sits
     * fully inside one cell rather than straddling a wall edge.
     */
    private findCoilCenter(): THREE.Vector3 | null {
        if (!this.head || !this.root) return null;

        this.head.getWorldPosition(this._headWorldPos);

        const cx = Math.floor(this._headWorldPos.x) + 0.5;
        const cz = Math.floor(this._headWorldPos.z) + 0.5;

        let cy = this.root.position.y;
        if (this.terrainOptions?.sampleGroundY) {
            const gy = this.terrainOptions.sampleGroundY(cx, cz);
            if (gy !== null) cy = gy;
        }

        return new THREE.Vector3(cx, cy, cz);
    }

    private isGroundFlat(center: THREE.Vector3): boolean {
        if (!this.terrainOptions?.sampleGroundY) return true;

        const centerY = center.y;
        const checkRadius = Math.min(this.tailDistance * 0.35, 1.5);
        const offsets: [number, number][] = [
            [checkRadius, 0], [-checkRadius, 0],
            [0, checkRadius], [0, -checkRadius],
        ];
        for (const [dx, dz] of offsets) {
            const gy = this.terrainOptions.sampleGroundY(center.x + dx!, center.z + dz!);
            if (gy !== null && Math.abs(gy - centerY) > 0.4) return false;
        }
        return true;
    }

    /** Spiral target for each idle position (segments then tail), centred on `center`. */
    private computeCoilTargets(center: THREE.Vector3): THREE.Vector3[] {
        if (!this.head || !this.root) return [];

        this.head.getWorldPosition(this._headWorldPos);
        const spineAboveFeet = this._headWorldPos.y - this.root.position.y;

        const coilRadius = this.tailDistance / (2 * Math.PI * 1.3);
        const baseAngle = this.coilFacingAngle + Math.PI;

        const targets: THREE.Vector3[] = [];
        for (let i = 0; i < this.idlePositions.length; i++) {
            const dist = i < this.segments.length
                ? this.segmentDistances[i]!
                : this.tailDistance;

            const angle = baseAngle + dist / coilRadius;
            const r = coilRadius * (0.7 + 0.3 * (dist / this.tailDistance));
            const x = center.x + Math.sin(angle) * r;
            const z = center.z + Math.cos(angle) * r;

            let y = center.y + spineAboveFeet;
            if (this.terrainOptions?.sampleGroundY) {
                const gy = this.terrainOptions.sampleGroundY(x, z);
                if (gy !== null) y = gy + spineAboveFeet;
            }

            targets.push(new THREE.Vector3(x, y, z));
        }
        return targets;
    }

    private advanceCoil(deltaTime: number): void {
        if (this.idlePositions.length === 0) return;

        const dt = Math.min(deltaTime, 0.05);

        if (this.head) {
            this.head.getWorldPosition(this._headWorldPos);
        }

        if (this.coilTargets.length > 0) {
            const rate = 1.5 * dt;
            for (let i = 0; i < this.idlePositions.length; i++) {
                if (i < this.coilTargets.length) {
                    this.idlePositions[i]!.lerp(this.coilTargets[i]!, rate);
                }
            }
        }

        if (this.terrainOptions?.sampleGroundY && this.root) {
            const spineAboveFeet = this._headWorldPos.y - this.root.position.y;
            for (const pos of this.idlePositions) {
                const gy = this.terrainOptions.sampleGroundY(pos.x, pos.z);
                if (gy !== null) {
                    const minY = gy + spineAboveFeet;
                    if (pos.y < minY) pos.y = minY;
                }
            }
        }
    }

    private placeSegmentsFromIdlePositions(wave: WaveParams): void {
        if (!this.root) return;

        for (let i = 0; i < this.segments.length; i++) {
            const segment = this.segments[i]!;
            const worldPos = this.idlePositions[i];
            if (!worldPos) continue;

            this._samplePos.copy(worldPos);

            const t = (i + 1) / (this.segments.length + 1);
            const phase = this.waveTime - t * Math.PI * 2 * wave.frequency;
            const breathe = Math.sin(phase) * wave.amplitude * 0.3;

            let tanX = 0; let tanZ = 1;
            if (i > 0) {
                const prev = this.idlePositions[i - 1]!;
                tanX = prev.x - worldPos.x;
                tanZ = prev.z - worldPos.z;
            } else if (this.head) {
                tanX = this._headWorldPos.x - worldPos.x;
                tanZ = this._headWorldPos.z - worldPos.z;
            }
            const tanLen = Math.sqrt(tanX * tanX + tanZ * tanZ);
            if (tanLen > 0.0001) { tanX /= tanLen; tanZ /= tanLen; }

            this._samplePos.x += -tanZ * breathe;
            this._samplePos.z += tanX * breathe;

            this.root.worldToLocal(this._samplePos);
            segment.position.copy(this._samplePos);

            this._localTangent.set(tanX, 0, tanZ).applyQuaternion(this._invQuat);
            segment.rotation.y = Math.atan2(this._localTangent.x, this._localTangent.z);
        }

        const tailIdx = this.segments.length;
        if (this.tail && tailIdx < this.idlePositions.length) {
            const worldPos = this.idlePositions[tailIdx]!;
            this._samplePos.copy(worldPos);

            const phase = this.waveTime - Math.PI * 2 * wave.frequency;
            const breathe = Math.sin(phase) * wave.amplitude * 0.2;

            let tanX = 0; let tanZ = 1;
            if (this.segments.length > 0) {
                const last = this.idlePositions[this.segments.length - 1]!;
                tanX = last.x - worldPos.x;
                tanZ = last.z - worldPos.z;
                const tanLen = Math.sqrt(tanX * tanX + tanZ * tanZ);
                if (tanLen > 0.0001) { tanX /= tanLen; tanZ /= tanLen; }
            }
            this._samplePos.x += -tanZ * breathe;
            this._samplePos.z += tanX * breathe;

            this.root.worldToLocal(this._samplePos);
            this.tail.position.copy(this._samplePos);

            this._localTangent.set(tanX, 0, tanZ).applyQuaternion(this._invQuat);
            this.tail.rotation.y = Math.atan2(this._localTangent.x, this._localTangent.z);
        }
    }

    // ─── TRAIL-BASED SEGMENT ANIMATION ───────────────────────────────

    /**
     * Put one body part on the trail `distance` behind the head, pushed sideways
     * by `sin(phase) * amplitude` for the slither wave, facing along the trail.
     * No-op while the trail has no sample that far back.
     */
    private placeOnTrail(part: THREE.Object3D, distance: number, phase: number, amplitude: number): void {
        if (!this.root) return;

        const sample = this.sampleTrail(distance);
        if (!sample) return;

        this._samplePos.copy(sample.pos);
        this._sampleTangent.copy(sample.tangent);

        this._perpendicular.set(-this._sampleTangent.z, 0, this._sampleTangent.x);
        const pLenSq = this._perpendicular.lengthSq();
        if (pLenSq > 0.0001) this._perpendicular.divideScalar(Math.sqrt(pLenSq));

        this._samplePos.addScaledVector(this._perpendicular, Math.sin(phase) * amplitude);

        this.root.worldToLocal(this._samplePos);
        part.position.copy(this._samplePos);

        this._localTangent.copy(this._sampleTangent).applyQuaternion(this._invQuat);
        part.rotation.y = Math.atan2(this._localTangent.x, this._localTangent.z);
    }

    private animateSegmentsFromTrail(wave: WaveParams): void {
        const count = this.segments.length;

        for (let i = 0; i < count; i++) {
            const t = (i + 1) / (count + 1);
            this.placeOnTrail(
                this.segments[i]!,
                this.segmentDistances[i]!,
                this.waveTime - t * Math.PI * 2 * wave.frequency,
                wave.amplitude * (1.0 - t * 0.25),
            );
        }
    }

    private animateTailFromTrail(wave: WaveParams): void {
        if (!this.tail) return;
        this.placeOnTrail(
            this.tail,
            this.tailDistance,
            this.waveTime - Math.PI * 2 * wave.frequency,
            wave.amplitude * 0.5,
        );
    }

    // ─── HEAD ANIMATION ─────────────────────────────────────────────────

    private animateHead(wave: WaveParams): void {
        if (!this.head) return;
        const headSway = Math.sin(this.waveTime) * wave.amplitude * 0.4;
        this.head.position.x = this.headRestPos.x + headSway;
        this.head.rotation.y = headSway * 2.5;

        const breath = 1.0 + Math.sin(this.waveTime * 0.4) * 0.015;
        this.head.scale.y = breath;
    }

    // ─── IDLE ANIMATION (LOCAL-SPACE FALLBACK — PRE-FIRST-MOVE ONLY) ──

    private animateSegmentsIdle(wave: WaveParams, deltaTime: number): void {
        const count = this.segments.length;
        if (count === 0 || !this.root || !this.head?.parent) return;

        const charGroup = this.head.parent;
        const lerpRateBase = 8.0;
        const dt = Math.min(deltaTime, 0.05);

        this.head.getWorldPosition(this._headWorldPos);
        const spineAboveFeet = this._headWorldPos.y - this.root.position.y;

        for (let i = 0; i < count; i++) {
            const segment = this.segments[i]!;
            const t = (i + 1) / (count + 1);

            const phase = this.waveTime - t * Math.PI * 2 * wave.frequency;
            const amplitude = wave.amplitude * (1.0 - t * 0.25);
            const targetX = Math.sin(phase) * amplitude;
            const targetZ = this.restPositions[i]!.z;

            const lerpRate = Math.max(3.0, 12.0 - i * 0.6);

            segment.position.x += (targetX - segment.position.x) * lerpRate * dt;
            segment.position.z += (targetZ - segment.position.z) * lerpRate * dt;

            if (this.terrainOptions?.sampleGroundY) {
                this._offLocal.subVectors(this.restPositions[i]!, this.headRestPos);
                this._offLocal.transformDirection(charGroup.matrixWorld);
                const sx = this._headWorldPos.x + this._offLocal.x;
                const sz = this._headWorldPos.z + this._offLocal.z;
                const gy = this.terrainOptions.sampleGroundY(sx, sz);
                if (gy !== null) {
                    const stagger = this.restPositions[i]!.y - this.headRestPos.y;
                    this._samplePos.set(sx, gy + spineAboveFeet + stagger, sz);
                    charGroup.worldToLocal(this._samplePos);
                    segment.position.y += (this._samplePos.y - segment.position.y) * lerpRateBase * dt;
                }
            }

            const prevPos = i === 0
                ? (this.head?.position ?? this.headRestPos)
                : this.segments[i - 1]!.position;

            const dx = prevPos.x - segment.position.x;
            const dz = prevPos.z - segment.position.z;
            if (dx * dx + dz * dz > 0.0001) {
                const targetAngle = Math.atan2(dx, dz);
                segment.rotation.y += (targetAngle - segment.rotation.y) * lerpRate * dt;
            }
        }
    }

    private animateTailIdle(wave: WaveParams, deltaTime: number): void {
        if (!this.tail || !this.root || !this.head?.parent) return;

        const charGroup = this.head.parent;
        const phase = this.waveTime - Math.PI * 2 * wave.frequency;
        const targetX = Math.sin(phase) * wave.amplitude * 0.5;

        const lerpRate = 5.0;
        const dt = Math.min(deltaTime, 0.05);
        this.tail.position.x += (targetX - this.tail.position.x) * lerpRate * dt;
        this.tail.position.z += (this.tailRestPos.z - this.tail.position.z) * lerpRate * dt;

        if (this.terrainOptions?.sampleGroundY) {
            this._offLocal.subVectors(this.tailRestPos, this.headRestPos);
            this._offLocal.transformDirection(charGroup.matrixWorld);
            this.head.getWorldPosition(this._headWorldPos);
            const spineAboveFeet = this._headWorldPos.y - this.root.position.y;
            const sx = this._headWorldPos.x + this._offLocal.x;
            const sz = this._headWorldPos.z + this._offLocal.z;
            const gy = this.terrainOptions.sampleGroundY(sx, sz);
            if (gy !== null) {
                const stagger = this.tailRestPos.y - this.headRestPos.y;
                this._samplePos.set(sx, gy + spineAboveFeet + stagger, sz);
                charGroup.worldToLocal(this._samplePos);
                this.tail.position.y += (this._samplePos.y - this.tail.position.y) * lerpRate * dt;
            }
        }

        if (this.segments.length > 0) {
            const last = this.segments[this.segments.length - 1]!;
            const dx = last.position.x - this.tail.position.x;
            const dz = last.position.z - this.tail.position.z;
            if (dx * dx + dz * dz > 0.0001) {
                const angle = Math.atan2(dx, dz);
                this.tail.rotation.y += (angle - this.tail.rotation.y) * lerpRate * dt;
            }
        }
    }

    // ─── TONGUE ANIMATION ───────────────────────────────────────────────

    private animateTongue(deltaTime: number): void {
        if (!this.tongue) return;

        this.tongueFlickTimer += deltaTime;

        if (!this.isTongueFlicking && this.tongueFlickTimer >= this.tongueFlickInterval) {
            this.isTongueFlicking = true;
            this.tongueTime = 0;
        }

        if (this.isTongueFlicking) {
            this.tongueTime += deltaTime;
            const flick = this.tongueTime / this.tongueFlickDuration;
            if (flick >= 1.0) {
                this.isTongueFlicking = false;
                this.tongueFlickTimer = 0;
                this.tongue.scale.z = 0.01;
                this.tongue.visible = false;
            } else {
                this.tongue.visible = true;
                const extend = flick < 0.3
                    ? flick / 0.3
                    : flick < 0.7
                        ? 1.0
                        : 1.0 - (flick - 0.7) / 0.3;
                this.tongue.scale.z = 0.01 + extend * 0.99;
                this.tongue.position.x = Math.sin(this.tongueTime * 30) * 0.003 * extend;
            }
        } else {
            this.tongue.visible = false;
        }
    }
}
