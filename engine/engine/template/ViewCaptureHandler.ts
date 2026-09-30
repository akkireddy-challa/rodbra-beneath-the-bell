// CAPTURE_VIEW — the engine half of the AI editor's `look` tool.
//
// The agent asks to see part of the game ("the knight NPC from four sides",
// "what the creator is looking at", "the whole level from above"). The Creator
// forwards the request here, we render it, upload one image and answer with
// VIEW_CAPTURE_RESPONSE { requestId, url, info } — or { requestId, error }.
//
// Framed shots render OFF-SCREEN through ScreenshotService with a camera fitted
// to the target's bounding box, so the creator's live view never flickers. The
// near plane is pushed up to just in front of the target, which clips away
// walls and trees standing between the camera and the thing being looked at.
//
// Only the WebGL/WebGPU canvas (and a 2D game's overlay canvases) is captured —
// never the DOM HUD. `info.hudIncluded` says so, so the agent cannot claim it
// saw the HUD. See game-play-agent/docs/look-tool.md.

import * as THREE from 'three';
import type { GameEngine } from 'engine/GameEngine.js';
import { getObjectIdService } from 'engine/ObjectIdService.js';
import { getGameStateManager } from 'engine/GameStateManager.js';
import type { CameraSpec } from 'engine/ScreenshotService.js';
import { getActiveEnvironmentObjectSystem } from 'engine/EnvironmentObjectSystem.js';
import { drawPins, engineActorPins, parsePinInputs, projectPins, type PinInput, type ViewPin } from 'engine/template/ViewPins.js';

export type Vec3 = { x: number; y: number; z: number };

export type ViewTarget =
    | { kind: 'current-view' }
    | { kind: 'player' }
    /** `id` is looked up in the scene; `position` (+ `radius`) frames a spot when the id is not found or not given. */
    | { kind: 'entity'; id?: string; position?: Vec3; radius?: number }
    | { kind: 'level'; preset: 'topdown' | 'isometric' }
    /**
     * A stored camera pose (a current view's `info.camera`), rendered off-screen at
     * `width`×`height`. The visual check after an edit uses it to re-take the
     * creator's view from exactly where they were looking, whatever the reload
     * did to the live camera.
     */
    | { kind: 'camera'; position: Vec3; forward: Vec3; fov: number; width: number; height: number };

export interface CaptureViewRequest {
    requestId: string;
    target: ViewTarget;
    /** 1 = one three-quarter view; 4 = front/right/back/left in one 2×2 sheet. */
    angles: 1 | 4;
    /**
     * false = answer with the image inline (`dataUrl`) instead of uploading it.
     * The prompt-time capture uses this: it travels in the prompt request, so an
     * upload would only add latency and spend the game's image rate limit.
     */
    upload: boolean;
    /** current-view only: scene objects to pin (the Creator's mention list). The player and NPCs are added here. */
    pins: PinInput[];
}

export interface ViewCaptureInfo {
    /** What was actually framed, in words — e.g. `npc "knight_1"`, `spot at (4, 0, -2)`. */
    resolved: string;
    /** World-space centre and size of the framed bounds, rounded to 0.01. Absent for current-view and level shots. */
    center?: [number, number, number];
    size?: [number, number, number];
    /** Labels of the tiles, in reading order (one entry for a single shot). */
    views: string[];
    gameState: string;
    hudIncluded: false;
    width: number;
    height: number;
    /** Set when the capture fell back or may be misleading (id not found, empty bounds, ...). */
    note?: string;
    /** current-view only: where the creator's camera is and which way it looks. */
    camera?: { position: [number, number, number]; forward: [number, number, number]; fov?: number };
    /** current-view only: the numbered pins drawn on the image, nearest first. */
    pins?: ViewPin[];
    /**
     * camera (stored pose) only: the share, 0..1, of a coarse ray grid through the shot that hits
     * world geometry within the fog's reach. 0 means the pose sees only sky or background — the
     * world moved (a forged or built level replaced the ground) and the old pose points at nothing.
     */
    geometryCoverage?: number;
}

export interface ViewCaptureResponse {
    requestId: string;
    url?: string;
    /** The image inline. Always set on success; the only image when the request asked for `upload: false`. */
    dataUrl?: string;
    info?: ViewCaptureInfo;
    error?: string;
}

const SHOT_FOV_DEG = 40;
const SINGLE_W = 768;
const SINGLE_H = 576;
const TILE_W = 512;
const TILE_H = 384;
const CURRENT_VIEW_LONG_SIDE = 768;
const LEVEL_W = 1024;
const LEVEL_H = 768;
const DEFAULT_SPOT_RADIUS = 1.5;
/** Which world corner an isometric camera sits in, by its azimuth (buildIsometricCamera: x = cos, z = sin). */
const ISO_CORNERS = ['camera at +X +Z', 'camera at -X +Z', 'camera at -X -Z', 'camera at +X -Z'];
const WEBP_QUALITY = 0.8;

/** Front three-quarter: the view a character sheet or asset thumbnail uses. */
const SINGLE_VIEW = { label: 'three-quarter front', yaw: Math.PI / 5, pitch: 0.35 };
const FOUR_VIEWS = [
    { label: 'front', yaw: 0, pitch: 0.2 },
    { label: 'right side', yaw: Math.PI / 2, pitch: 0.2 },
    { label: 'back', yaw: Math.PI, pitch: 0.2 },
    { label: 'left side', yaw: -Math.PI / 2, pitch: 0.2 },
];

interface FramedTarget {
    box: THREE.Box3;
    /** Horizontal unit vector the target faces (+Z local, per the gameplay convention). */
    forward: THREE.Vector3;
    resolved: string;
    note?: string;
}

function round2(v: number): number {
    return Math.round(v * 100) / 100;
}

function triple(v: THREE.Vector3): [number, number, number] {
    return [round2(v.x), round2(v.y), round2(v.z)];
}

function isVec3(value: unknown): value is Vec3 {
    const v = value as Partial<Vec3> | null;
    return !!v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number';
}

/** Validate the untrusted postMessage payload into a request, or explain why not. */
export function parseCaptureViewRequest(data: unknown): CaptureViewRequest | string {
    const d = data as { requestId?: unknown; target?: unknown; angles?: unknown; upload?: unknown; pins?: unknown } | null;
    if (!d || typeof d.requestId !== 'string' || !d.requestId) return 'missing requestId';
    const t = d.target as { kind?: unknown; id?: unknown; position?: unknown; radius?: unknown; preset?: unknown } | null;
    if (!t || typeof t.kind !== 'string') return 'missing target';
    const angles: 1 | 4 = d.angles === 4 ? 4 : 1;
    // Shared by every kind; current-view is the only one with pins, and a stored
    // camera pose is always a single shot, so those two override their field.
    const base = { requestId: d.requestId, angles, upload: d.upload !== false, pins: [] as PinInput[] };
    switch (t.kind) {
        case 'current-view':
            return { ...base, target: { kind: t.kind }, pins: parsePinInputs(d.pins) };
        case 'player':
            return { ...base, target: { kind: t.kind } };
        case 'entity': {
            const id = typeof t.id === 'string' && t.id ? t.id : undefined;
            const position = isVec3(t.position) ? t.position : undefined;
            if (!id && !position) return 'entity target needs an id or a position';
            const radius = typeof t.radius === 'number' && t.radius > 0 ? t.radius : undefined;
            return { ...base, target: { kind: 'entity', id, position, radius } };
        }
        case 'camera': {
            const c = t as { position?: unknown; forward?: unknown; fov?: unknown; width?: unknown; height?: unknown };
            if (!isVec3(c.position) || !isVec3(c.forward)) return 'camera target needs position and forward';
            const fov = typeof c.fov === 'number' && c.fov > 1 && c.fov < 179 ? c.fov : 50;
            const width = typeof c.width === 'number' ? Math.round(Math.min(Math.max(c.width, 64), 1024)) : SINGLE_W;
            const height = typeof c.height === 'number' ? Math.round(Math.min(Math.max(c.height, 64), 1024)) : SINGLE_H;
            return { ...base, angles: 1, target: { kind: 'camera', position: c.position, forward: c.forward, fov, width, height } };
        }
        case 'level':
            return { ...base, target: { kind: 'level', preset: t.preset === 'topdown' ? 'topdown' : 'isometric' } };
        default:
            return `unknown target kind "${t.kind}"`;
    }
}

function horizontalForward(object: THREE.Object3D): THREE.Vector3 {
    const q = new THREE.Quaternion();
    object.getWorldQuaternion(q);
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    forward.y = 0;
    return forward.lengthSq() > 1e-6 ? forward.normalize() : new THREE.Vector3(0, 0, 1);
}

function boundsOf(object: THREE.Object3D): THREE.Box3 | null {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty() || !Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return null;
    return box;
}

function spotBox(position: Vec3, radius: number): THREE.Box3 {
    const center = new THREE.Vector3(position.x, position.y + radius, position.z);
    return new THREE.Box3().setFromCenterAndSize(center, new THREE.Vector3(radius * 2, radius * 2, radius * 2));
}

/** Find a scene object for `id`: registered ids, NPC ids and names, then object names. */
function findObject(engine: GameEngine, id: string): { object: THREE.Object3D; label: string } | null {
    const registered = getObjectIdService().getObjectById(id);
    if (registered) return { object: registered, label: `object "${id}"` };

    const npcs = engine.getNpcRegistry();
    if (npcs) {
        const byId = npcs.getAllControllers().find(npc => npc.getId() === id);
        if (byId) return { object: byId.getCharacter(), label: `npc "${id}"` };
        const direct = npcs.getController(id);
        if (direct) return { object: direct.getCharacter(), label: `npc "${id}"` };
        const first = npcs.get(id)?.getAllNpcs()[0];
        if (first) return { object: first.getCharacter(), label: `npc type "${id}" (first of ${npcs.get(id)?.getAllNpcs().length ?? 1})` };
    }

    const scene = engine.scene;
    if (scene) {
        const named = scene.getObjectByName(id);
        if (named) return { object: named, label: `scene object "${id}"` };
        let tagged: THREE.Object3D | null = null;
        scene.traverse(obj => {
            if (!tagged && obj.userData?.objectId === id) tagged = obj;
        });
        if (tagged) return { object: tagged, label: `scene object "${id}"` };
    }
    return null;
}

function frameTarget(engine: GameEngine, target: ViewTarget): FramedTarget | string {
    if (target.kind === 'player') {
        const controller = engine.getPlayerController();
        const player = controller?.getPlayerObject?.() ?? null;
        if (!player) return 'no player in this game';
        // Before Play the per-frame update has not posed the visible body onto the player yet.
        controller?.syncVisibleBody?.();
        const box = boundsOf(player);
        if (!box) return 'player has no visible geometry';
        return { box, forward: horizontalForward(player), resolved: 'player' };
    }
    if (target.kind !== 'entity') return `target kind "${target.kind}" is not framed`;

    const found = target.id ? findObject(engine, target.id) : null;
    if (found) {
        const box = boundsOf(found.object);
        if (box) return { box, forward: horizontalForward(found.object), resolved: found.label };
        if (!target.position) return `${found.label} has no visible geometry (hidden or not built yet)`;
    }
    if (target.position) {
        const radius = target.radius ?? DEFAULT_SPOT_RADIUS;
        const p = target.position;
        return {
            box: spotBox(p, radius),
            forward: new THREE.Vector3(0, 0, 1),
            resolved: `spot at (${round2(p.x)}, ${round2(p.y)}, ${round2(p.z)})`,
            note: target.id ? `id "${target.id}" was not found in the running scene — framed the given position instead` : undefined,
        };
    }
    return `no object with id "${target.id}" in the running scene — pass the position from world.json instead`;
}

/**
 * A camera that fits the target's bounding sphere, orbiting `yaw` radians around it
 * from the target's front. The near plane sits just in front of the target so
 * occluders between camera and target are clipped away.
 */
export function buildFramingCamera(
    box: THREE.Box3,
    forward: THREE.Vector3,
    view: { yaw: number; pitch: number },
    aspect: number,
): THREE.PerspectiveCamera {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.25);
    const halfFov = THREE.MathUtils.degToRad(SHOT_FOV_DEG) / 2;
    // Fit against the narrower of the two FOVs so the target fits both ways.
    const halfFovH = Math.atan(Math.tan(halfFov) * aspect);
    const distance = (radius / Math.sin(Math.min(halfFov, halfFovH))) * 1.1;

    const dir = forward.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), view.yaw);
    const offset = dir.multiplyScalar(Math.cos(view.pitch) * distance);
    offset.y = Math.sin(view.pitch) * distance;

    const near = Math.max(0.05, distance - radius * 1.3);
    const camera = new THREE.PerspectiveCamera(SHOT_FOV_DEG, aspect, near, distance + radius * 50 + 500);
    camera.position.copy(sphere.center).add(offset);
    camera.lookAt(sphere.center);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();
    return camera;
}

function makeCanvas(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    return { canvas, ctx };
}

function canvasToWebp(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))), 'image/webp', WEBP_QUALITY);
    });
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
    ctx.font = 'bold 18px sans-serif';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(x + 6, y + 6, w, 26);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x + 12, y + 25);
}

function isCanvasVisible(c: HTMLCanvasElement): boolean {
    if (!c.width || !c.height) return false;
    const style = getComputedStyle(c);
    return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * The creator's current view, as they see it: the renderer canvas plus any other
 * visible canvas on top (a Physics2D game draws into an overlay 2D canvas),
 * scaled so the long side is CURRENT_VIEW_LONG_SIDE. Relies on
 * preserveDrawingBuffer, which is on in creator mode.
 */
async function captureCurrentView(
    engine: GameEngine,
    pinInputs: readonly PinInput[],
): Promise<{ blob: Blob; width: number; height: number; pins: ViewPin[]; camera?: ViewCaptureInfo['camera'] }> {
    const rendererCanvas = engine.getRenderer().domElement;
    const scale = CURRENT_VIEW_LONG_SIDE / Math.max(rendererCanvas.width, rendererCanvas.height, 1);
    const width = Math.max(1, Math.round(rendererCanvas.width * scale));
    const height = Math.max(1, Math.round(rendererCanvas.height * scale));
    const { canvas, ctx } = makeCanvas(width, height);
    const others = Array.from(document.querySelectorAll('canvas')).filter(c => c !== rendererCanvas);
    for (const c of [rendererCanvas, ...others]) {
        if (c === rendererCanvas || isCanvasVisible(c)) ctx.drawImage(c, 0, 0, width, height);
    }

    // The camera the frame was actually drawn with (GameEngine.renderActiveFrame).
    const viewCamera = engine.editorManager?.getObjectEditModeCamera?.() ?? engine.camera;
    let pins: ViewPin[] = [];
    let camera: ViewCaptureInfo['camera'];
    if (viewCamera) {
        pins = projectPins([...engineActorPins(engine), ...pinInputs], viewCamera, width, height);
        drawPins(ctx, pins);
        const position = new THREE.Vector3().setFromMatrixPosition(viewCamera.matrixWorld);
        const forward = viewCamera.getWorldDirection(new THREE.Vector3());
        const fov = viewCamera instanceof THREE.PerspectiveCamera ? round2(viewCamera.fov) : undefined;
        camera = { position: triple(position), forward: triple(forward), fov };
    }
    return { blob: await canvasToWebp(canvas), width, height, pins, camera };
}

/**
 * Give a shot camera the live camera's render layers. A fresh camera sees layer 0
 * only, and block characters — the player and block NPCs — render on layer 1
 * (CharacterLoader.applyBlockPartMaterial), so without this a look at the player
 * shows the ground where they stand and, at most, their shadow.
 */
function seeLiveLayers<T extends THREE.Camera>(engine: GameEngine, camera: T): T {
    if (engine.camera) camera.layers.mask = engine.camera.layers.mask;
    return camera;
}

/**
 * Run a capture with the player body forced visible when `show` is set, then put
 * the visibility back. The live view may catch the body for a frame or two.
 */
async function withPlayerShown<T>(engine: GameEngine, show: boolean, capture: () => Promise<T>): Promise<T> {
    if (!show) return capture();
    const visibility = engine.getPlayerVisibility();
    const override = visibility.getManualOverride();
    visibility.setManualOverride(true);
    try {
        return await capture();
    } finally {
        visibility.setManualOverride(override);
    }
}

/** Fog distances that put every fragment of any level in clear air. */
const FOG_OUT_OF_REACH = 1e7;

/**
 * Run a FRAMED capture (a spot, the player, the whole level) with the fog pushed out of reach,
 * then put it back. A framing camera stands back far enough to fit its target — ~500 m for a
 * forged arena — and at that distance the scene's fog (500 m by default) paints the whole target
 * in the fog colour: the visual check read a new arena as a blank blue frame. These shots are a
 * look at the geometry, not at the atmosphere. Only the uniforms change, so no material recompiles.
 */
async function withoutFog<T>(engine: GameEngine, capture: () => Promise<T>): Promise<T> {
    const fog = engine.scene?.fog;
    if (fog instanceof THREE.Fog) {
        const { near, far } = fog;
        fog.near = FOG_OUT_OF_REACH;
        fog.far = FOG_OUT_OF_REACH * 2;
        try {
            return await capture();
        } finally {
            fog.near = near;
            fog.far = far;
        }
    }
    if (fog instanceof THREE.FogExp2) {
        const { density } = fog;
        fog.density = 0;
        try {
            return await capture();
        } finally {
            fog.density = density;
        }
    }
    return capture();
}

const COVERAGE_COLS = 6;
const COVERAGE_ROWS = 4;

/**
 * The share of a COVERAGE_COLS × COVERAGE_ROWS ray grid through `camera` that hits the world
 * group (terrain, the mesh level, placed objects) before the fog swallows it. The skybox lives on
 * the scene, not the world group, so sky never counts. Pure over the given scene graph.
 */
export function geometryCoverage(camera: THREE.PerspectiveCamera, world: THREE.Object3D, reach: number): number {
    const raycaster = new THREE.Raycaster();
    raycaster.far = reach;
    raycaster.layers.mask = camera.layers.mask;
    const ndc = new THREE.Vector2();
    let hits = 0;
    for (let row = 0; row < COVERAGE_ROWS; row++) {
        for (let col = 0; col < COVERAGE_COLS; col++) {
            ndc.set(((col + 0.5) / COVERAGE_COLS) * 2 - 1, ((row + 0.5) / COVERAGE_ROWS) * 2 - 1);
            raycaster.setFromCamera(ndc, camera);
            if (raycaster.intersectObject(world, true).length > 0) hits++;
        }
    }
    return hits / (COVERAGE_COLS * COVERAGE_ROWS);
}

/** How far a shot can see anything: the fog's far distance, else the camera's. */
function visibleReach(engine: GameEngine, camera: THREE.PerspectiveCamera): number {
    const fog = engine.scene?.fog;
    return fog instanceof THREE.Fog ? Math.min(fog.far, camera.far) : camera.far;
}

/**
 * Environment objects are culled against the LIVE camera each frame, so an
 * off-screen shot from anywhere else would miss whatever the creator is not
 * looking at — and the visual check would read a culled object as "gone".
 * Cull against the shot's camera first. No restore needed: the next frame
 * culls against the live camera again (GameEngine's render loop).
 */
function cullFor(camera: THREE.Camera): void {
    const env = getActiveEnvironmentObjectSystem();
    env?.updateInstanceCulling(camera);
    env?.updateVisibility(camera);
}

async function captureSheet(
    engine: GameEngine,
    specs: { label: string; camera: CameraSpec }[],
    tileW: number,
    tileH: number,
): Promise<{ blob: Blob; width: number; height: number }> {
    const service = engine.getScreenshotService();
    const [only] = specs;
    if (specs.length === 1 && only) {
        if (only.camera.kind === 'custom') cullFor(only.camera.camera);
        const single = await service.capture({ camera: only.camera, width: tileW, height: tileH });
        return { blob: single, width: tileW, height: tileH };
    }
    const cols = 2;
    const rows = Math.ceil(specs.length / cols);
    const { canvas, ctx } = makeCanvas(tileW * cols, tileH * rows);
    for (const [i, spec] of specs.entries()) {
        if (spec.camera.kind === 'custom') cullFor(spec.camera.camera);
        const tile = await createImageBitmap(await service.capture({ camera: spec.camera, width: tileW, height: tileH }));
        const x = (i % cols) * tileW;
        const y = Math.floor(i / cols) * tileH;
        ctx.drawImage(tile, x, y, tileW, tileH);
        tile.close();
        drawLabel(ctx, spec.label, x, y);
    }
    return { blob: await canvasToWebp(canvas), width: canvas.width, height: canvas.height };
}

async function render(engine: GameEngine, request: CaptureViewRequest): Promise<{ blob: Blob; info: ViewCaptureInfo }> {
    const gameState = String(getGameStateManager().getCurrentState());
    const base = { gameState, hudIncluded: false as const };

    if (request.target.kind === 'current-view') {
        const shot = await captureCurrentView(engine, request.pins);
        return {
            blob: shot.blob,
            info: {
                ...base,
                resolved: 'the creator\'s current view',
                views: ['current view'],
                width: shot.width,
                height: shot.height,
                camera: shot.camera,
                pins: shot.pins,
            },
        };
    }

    if (request.target.kind === 'level') {
        const specs: { label: string; camera: CameraSpec }[] = request.target.preset === 'topdown'
            ? [{ label: 'top-down', camera: { kind: 'topdown', fitLevel: true, height: null, tilt: 0, margin: null } }]
            : (request.angles === 4 ? [0, 1, 2, 3] : [0]).map(i => ({
                label: `isometric, ${ISO_CORNERS[i] ?? ''}`,
                camera: { kind: 'isometric', fitLevel: true, distance: null, azimuth: Math.PI / 4 + (i * Math.PI) / 2, margin: null },
            }));
        const tiled = specs.length > 1;
        const shot = await withoutFog(engine, () => captureSheet(engine, specs, tiled ? TILE_W : LEVEL_W, tiled ? TILE_H : LEVEL_H));
        return {
            blob: shot.blob,
            info: { ...base, resolved: 'the whole level', views: specs.map(s => s.label), width: shot.width, height: shot.height },
        };
    }

    if (request.target.kind === 'camera') {
        const { position, forward, fov, width, height } = request.target;
        const cam = new THREE.PerspectiveCamera(fov, width / height, 0.1, 10000);
        cam.position.set(position.x, position.y, position.z);
        cam.lookAt(position.x + forward.x, position.y + forward.y, position.z + forward.z);
        cam.updateMatrixWorld(true);
        cam.updateProjectionMatrix();
        seeLiveLayers(engine, cam);
        cullFor(cam);
        // The visual check replays the creator's view against the reloaded game, which
        // sits before Play with the player hidden — the BEFORE was taken mid-game.
        const notStarted = !getGameStateManager().hasStarted();
        if (notStarted) engine.getPlayerController()?.syncVisibleBody?.();
        const blob = await withPlayerShown(engine, notStarted, () =>
            engine.getScreenshotService().capture({ camera: { kind: 'custom', camera: cam }, width, height }));
        const coverage = round2(geometryCoverage(cam, engine.getWorldGroup(), visibleReach(engine, cam)));
        return {
            blob,
            info: {
                ...base,
                resolved: 'a stored camera pose',
                views: ['camera pose'],
                width,
                height,
                geometryCoverage: coverage,
                ...(coverage === 0 ? { note: 'this pose sees no world geometry — only sky or background' } : {}),
            },
        };
    }

    const framed = frameTarget(engine, request.target);
    if (typeof framed === 'string') throw new Error(framed);
    const views = request.angles === 4 ? FOUR_VIEWS : [SINGLE_VIEW];
    const tileW = views.length > 1 ? TILE_W : SINGLE_W;
    const tileH = views.length > 1 ? TILE_H : SINGLE_H;
    const specs = views.map(view => ({
        label: view.label,
        camera: { kind: 'custom' as const, camera: seeLiveLayers(engine, buildFramingCamera(framed.box, framed.forward, view, tileW / tileH)) },
    }));
    // Before Play the player body is hidden ('not-started' in PlayerVisibility), and a
    // look at the player is still asking what the character looks like.
    const shot = await withPlayerShown(engine, request.target.kind === 'player', () =>
        withoutFog(engine, () => captureSheet(engine, specs, tileW, tileH)));
    return {
        blob: shot.blob,
        info: {
            ...base,
            resolved: framed.resolved,
            center: triple(framed.box.getCenter(new THREE.Vector3())),
            size: triple(framed.box.getSize(new THREE.Vector3())),
            views: views.map(v => v.label),
            width: shot.width,
            height: shot.height,
            note: framed.note,
        },
    };
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('FileReader returned no data URL')));
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.readAsDataURL(blob);
    });
}

/** Handle one CAPTURE_VIEW message. Always posts exactly one VIEW_CAPTURE_RESPONSE when a requestId is present. */
export async function handleCaptureView(
    engine: GameEngine | null,
    data: unknown,
    post: (message: { type: 'VIEW_CAPTURE_RESPONSE'; data: ViewCaptureResponse }) => void,
): Promise<void> {
    const parsed = parseCaptureViewRequest(data);
    if (typeof parsed === 'string') {
        const requestId = (data as { requestId?: unknown } | null)?.requestId;
        if (typeof requestId === 'string') post({ type: 'VIEW_CAPTURE_RESPONSE', data: { requestId, error: parsed } });
        console.warn(`[ViewCapture] Rejected CAPTURE_VIEW: ${parsed}`);
        return;
    }
    if (!engine) {
        post({ type: 'VIEW_CAPTURE_RESPONSE', data: { requestId: parsed.requestId, error: 'the game has not finished loading' } });
        return;
    }
    try {
        const { blob, info } = await render(engine, parsed);
        const dataUrl = await blobToDataUrl(blob);
        // The inline copy always goes back: the Creator keeps it as the "before" of
        // the visual check after the edit, which compares images without fetching
        // anything. The upload is what the agent's `look` tool reads.
        const url = parsed.upload ? (await engine.getScreenshotService().upload(blob, `agent-look-${Date.now()}`)).url : undefined;
        post({ type: 'VIEW_CAPTURE_RESPONSE', data: { requestId: parsed.requestId, url, dataUrl, info } });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn('[ViewCapture] Capture failed:', message);
        post({ type: 'VIEW_CAPTURE_RESPONSE', data: { requestId: parsed.requestId, error: message } });
    }
}
