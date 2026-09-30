import * as THREE from 'three';

/**
 * The first-person view-model layer — a weapon drawn in front of the camera, in
 * its own scene, with its own depth space and its own light rig.
 *
 * This is the primitive a first-person weapon needs and the engine did not have.
 * Putting the weapon in the MAIN scene, which is how the shipped melee view
 * model works today, means it shares the world's depth buffer (so backing into
 * a wall pushes the wall through the weapon), the world's fog and depth of
 * field (so the weapon blurs when the player focuses on something distant), and
 * the world's field of view (so a wide-FOV game has a distorted gun). Rendering
 * a separate scene after the world, with the depth buffer cleared, fixes all
 * three at once and costs no layer bit — which matters, because layers 0-3 are
 * already spoken for.
 *
 * THE CAMERA NEVER MOVES. It sits at the origin looking down -Z, and weapons are
 * positioned in camera-local coordinates, so the layer is a small diorama that
 * is by construction always in front of the viewer. There is no follow step to
 * run at the wrong point in the frame and no chance of the weapon lagging the
 * camera by a frame. Anything that needs a world-space position — a muzzle, a
 * projectile origin — composes the main camera's world matrix with the object's
 * local matrix, which is exact because the two cameras share a transform.
 *
 * Rendering is dual-pathed by renderer CLASS, not by backend, and the two paths
 * are genuinely different — see GameEngine.renderActiveFrame (classic WebGL
 * canvas overlay) and GameEnginePostFx (WebGPU node composite). The reason is
 * recorded at both sites: on the unified renderer a plain second `render()` to
 * the canvas does not do what it appears to.
 */

export interface ViewModelLayerOptions {
    /**
     * Vertical field of view in landscape, horizontal in portrait — deliberately independent
     * of the world's. Shooters keep the weapon around 55-70 degrees while the
     * world FOV moves for sprint, aim and player preference; slaving the two
     * together is what makes a wide-FOV game's gun look bent.
     */
    fovDegrees: number;
    /** Near plane. Tiny, and free: this scene has its own depth buffer. */
    near: number;
    /** Far plane. A view model is centimetres away; metres is already generous. */
    far: number;

    /** Key light, from over the player's left shoulder. */
    keyLightIntensity: number;
    keyLightDirection: THREE.Vector3;
    /** Opposite-side fill, so the unlit side reads as shape rather than a hole. */
    fillLightIntensity: number;
    /** Flat ambient floor. */
    ambientIntensity: number;

    /** Reach of the muzzle-flash light, metres. */
    flashLightDistance: number;
    /** Falloff exponent for the muzzle-flash light. */
    flashLightDecay: number;
}

export const DEFAULT_VIEW_MODEL_LAYER_OPTIONS: ViewModelLayerOptions = {
    fovDegrees: 60,
    near: 0.01,
    far: 10,
    // Bright by design. A view model is closer to a HUD element than to scenery:
    // it has to read clearly at midnight, in a cave, and against a blown-out sky,
    // so it is lit for legibility rather than for physical plausibility.
    keyLightIntensity: 3.6,
    keyLightDirection: new THREE.Vector3(-0.4, 0.8, 0.6),
    fillLightIntensity: 1.4,
    ambientIntensity: 1.8,
    // Reach far enough to wash the whole view model, not just the muzzle end.
    flashLightDistance: 3.0,
    flashLightDecay: 2,
};

/** The subset of a renderer this layer drives on the classic WebGL path. */
interface OverlayRenderer {
    autoClear: boolean;
    clearDepth(): void;
    render(scene: THREE.Scene, camera: THREE.Camera): void;
    getDrawingBufferSize(target: THREE.Vector2): THREE.Vector2;
}

export class ViewModelLayer {
    /** Read by GameEnginePostFx to build the WebGPU composite node. */
    readonly scene: THREE.Scene;
    readonly camera: THREE.PerspectiveCamera;

    /**
     * A permanently-present light for weapon effects to drive, idling at zero
     * intensity.
     *
     * It exists whether or not a weapon is held, and that is the entire point.
     * On WebGPU, changing the SET of lights a scene contains forces a
     * synchronous recompile of every material in it — so a flash light that
     * appeared when you picked a weapon up and vanished when you dropped it
     * would stall the frame on both. Keeping the count constant makes the scene's
     * lighting configuration a fixed property of the layer, and leaves effects
     * with only uniforms to change (position, colour, intensity), which are free.
     *
     * Same reasoning as PointLightPool, which keeps the world's light count
     * stable for exactly this reason.
     */
    readonly flashLight: THREE.PointLight;

    private readonly options: ViewModelLayerOptions;
    private readonly attachments = new Set<THREE.Object3D>();
    private readonly bufferSize = new THREE.Vector2();
    private fovOffsetDegrees = 0;
    private aspect = 1;

    constructor(options: ViewModelLayerOptions = DEFAULT_VIEW_MODEL_LAYER_OPTIONS) {
        this.options = options;

        this.scene = new THREE.Scene();
        this.scene.name = 'ViewModelScene';
        // Both must stay null. A scene background forces a colour clear even
        // with autoClear off, which would wipe the world out from behind the
        // weapon on the overlay path; world fog has no business tinting an
        // object held at arm's length.
        this.scene.background = null;
        this.scene.fog = null;

        this.camera = new THREE.PerspectiveCamera(
            options.fovDegrees, 1, options.near, options.far,
        );
        this.camera.name = 'ViewModelCamera';
        // Render EVERY layer. Layers are a main-scene mechanism — bloom-only,
        // shadow-only, editor-picking exclusion, "visual-only" weapons — and
        // none of those meanings survive into a private scene that draws
        // nothing but what a weapon system deliberately put there. Leaving the
        // default layer-0 mask silently drops real weapons: the registry's own
        // makeRangedWeaponVisualOnly moves every mesh to layer 2, so a stock
        // assault rifle attached here would be attached, posed, lit, and
        // invisible.
        this.camera.layers.enableAll();

        // A dedicated rig, so the weapon reads the same at noon and at midnight.
        // Real shooters light the view model separately for exactly this reason:
        // a weapon that disappears into shadow is a HUD element that stopped
        // working, not an atmospheric touch.
        const key = new THREE.DirectionalLight(0xffffff, options.keyLightIntensity);
        key.position.copy(options.keyLightDirection).normalize().multiplyScalar(5);
        key.castShadow = false;
        this.scene.add(key);

        const fill = new THREE.DirectionalLight(0xffffff, options.fillLightIntensity);
        fill.position.copy(options.keyLightDirection).normalize().multiplyScalar(-5);
        fill.castShadow = false;
        this.scene.add(fill);

        this.scene.add(new THREE.AmbientLight(0xffffff, options.ambientIntensity));

        // Part of the permanent rig — see the field's note. Intensity 0 means it
        // contributes nothing until an effect drives it.
        this.flashLight = new THREE.PointLight(
            0xffffff, 0, options.flashLightDistance, options.flashLightDecay,
        );
        this.flashLight.name = 'ViewModelFlashLight';
        this.flashLight.castShadow = false;
        this.scene.add(this.flashLight);
    }

    /**
     * Put an object in the view-model scene. Its transform is CAMERA-LOCAL:
     * +X right, +Y up, -Z forward, origin at the eye.
     */
    attach(object: THREE.Object3D): void {
        if (this.attachments.has(object)) return;
        this.attachments.add(object);
        this.scene.add(object);
    }

    detach(object: THREE.Object3D): void {
        if (!this.attachments.delete(object)) return;
        this.scene.remove(object);
    }

    /** Whether anything is currently being shown. */
    hasContent(): boolean {
        return this.attachments.size > 0;
    }

    /**
     * Narrow the weapon's field of view, in degrees, for aiming down sights.
     *
     * Much smaller than the world's narrowing: the point is to keep the weapon
     * from ballooning as the world zooms, not to zoom the weapon too.
     */
    setFovOffset(offsetDegrees: number): void {
        if (this.fovOffsetDegrees === offsetDegrees) return;
        this.fovOffsetDegrees = offsetDegrees;
        this.applyProjection();
    }

    /**
     * Keep the projection matching the drawing buffer.
     *
     * Called every frame rather than only from the engine's resize handler,
     * because the screen recorder resizes the renderer directly without going
     * through it. The comparison makes the common case a no-op.
     */
    syncProjection(renderer: OverlayRenderer): void {
        renderer.getDrawingBufferSize(this.bufferSize);
        const { x: width, y: height } = this.bufferSize;
        if (width <= 0 || height <= 0) return;
        const aspect = width / height;
        if (Math.abs(aspect - this.aspect) < 1e-6) return;
        this.aspect = aspect;
        this.applyProjection();
    }

    private applyProjection(): void {
        this.camera.aspect = this.aspect;
        const fov = Math.max(this.options.fovDegrees - this.fovOffsetDegrees, 1);
        // Keep the authored off-centre grip visible on narrow viewports. With
        // fixed vertical FOV a portrait phone crops the gun almost completely.
        // Landscape framing is unchanged; portrait preserves a square view's width.
        this.camera.fov = this.aspect >= 1 ? fov : THREE.MathUtils.radToDeg(2 * Math.atan(
            Math.tan(THREE.MathUtils.degToRad(fov) / 2) / this.aspect,
        ));
        this.camera.updateProjectionMatrix();
    }

    /**
     * Draw the view model on top of the finished frame, on the CLASSIC WebGL
     * renderer only.
     *
     * Clearing depth is what makes the weapon un-clippable: the world has
     * already been rasterised, so wiping depth and drawing into the same colour
     * buffer puts the weapon in front of everything with no chance of a wall
     * intersecting it.
     *
     * Deliberately does NOT bind the canvas — it draws into whatever target is
     * already bound. GameEngine.warmUpScene renders into an offscreen target and
     * relies on that frame never reaching the screen.
     *
     * MUST NOT be called on WebGPURenderer. There, `render()` is routed through
     * an intermediate HDR target whenever tone mapping is on (which it always
     * is here) and `clearDepth()` alone triggers a full-screen blit of that
     * target over the canvas — the screen goes black with a weapon floating on
     * it. The WebGPU path composites through the node graph instead.
     */
    renderOverlay(renderer: OverlayRenderer): void {
        const previousAutoClear = renderer.autoClear;
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(this.scene, this.camera);
        renderer.autoClear = previousAutoClear;
    }

    /**
     * Drop everything attached. Geometry and materials belong to whatever
     * attached them, so they are detached rather than disposed; the lights are
     * this layer's own.
     */
    dispose(): void {
        for (const object of this.attachments) this.scene.remove(object);
        this.attachments.clear();
        this.scene.clear();
    }
}
