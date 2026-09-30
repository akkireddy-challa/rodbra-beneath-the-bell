import * as THREE from 'three';
import {
    configureDirectionalShadow, resolveShadowDistance, resolveShadowMapSize,
    DEFAULT_SHADOW_DISTANCE, SHADOW_MAP_MAX_SIZE_DESKTOP, SHADOW_MAP_MAX_SIZE_MOBILE,
    type ShadowConfig,
} from 'engine/ShadowCamera.js';
import type { TerrainBounds } from 'engine/DynamicObjectManager.js';
import { setActiveRendererType } from 'engine/RendererType.js';

function bounds(sizeX: number, sizeZ: number): TerrainBounds {
    return { minX: 0, minY: 0, minZ: 0, maxX: sizeX, maxY: 32, maxZ: sizeZ };
}

/**
 * The device class is now a numeric cap from the quality tier rather than a mobile flag.
 * These two are the caps the ladder's rungs carry, so every assertion below keeps its
 * original meaning — "the desktop cap" and "the mobile cap" — while testing the new shape.
 */
const DESKTOP_CAP = SHADOW_MAP_MAX_SIZE_DESKTOP;
const MOBILE_CAP = SHADOW_MAP_MAX_SIZE_MOBILE;

describe('resolveShadowDistance', () => {
    it('keeps the plain default while bounds are unknown', () => {
        expect(resolveShadowDistance(undefined, null)).toBe(DEFAULT_SHADOW_DISTANCE);
    });

    it('an explicit renderConfig.shadowDistance always wins, bounds or not', () => {
        expect(resolveShadowDistance(350, bounds(50, 50))).toBe(350);
        expect(resolveShadowDistance(80, null)).toBe(80);
    });

    it('shrinks the default to the world XZ diagonal on small worlds', () => {
        // 60x60 world → diagonal ~84.9 — full coverage from any player position.
        expect(resolveShadowDistance(undefined, bounds(60, 60))).toBeCloseTo(Math.hypot(60, 60), 5);
    });

    it('never grows past the default on large worlds, never collapses below the floor', () => {
        expect(resolveShadowDistance(undefined, bounds(400, 400))).toBe(DEFAULT_SHADOW_DISTANCE);
        expect(resolveShadowDistance(undefined, bounds(4, 4))).toBe(40);
    });
});

describe('resolveShadowMapSize', () => {
    it('default distance keeps the legacy 4096 on desktop but caps mobile at 2048', () => {
        expect(resolveShadowMapSize(DEFAULT_SHADOW_DISTANCE, DESKTOP_CAP)).toBe(4096);
        expect(resolveShadowMapSize(DEFAULT_SHADOW_DISTANCE, MOBILE_CAP)).toBe(2048);
    });

    it('small coverage radii resolve to small maps on both device classes', () => {
        expect(resolveShadowMapSize(40, DESKTOP_CAP)).toBe(1024);
        expect(resolveShadowMapSize(40, MOBILE_CAP)).toBe(1024);
        expect(resolveShadowMapSize(85, DESKTOP_CAP)).toBe(2048);
    });

    it('floors at 512 for degenerate radii', () => {
        expect(resolveShadowMapSize(1, DESKTOP_CAP)).toBe(512);
    });

    it('an explicit renderConfig.shadowMapSize replaces the density ladder', () => {
        expect(resolveShadowMapSize(200, DESKTOP_CAP, 1024)).toBe(1024);
        expect(resolveShadowMapSize(40, DESKTOP_CAP, 4096)).toBe(4096);
    });

    it('explicit sizes snap to the nearest power of two', () => {
        expect(resolveShadowMapSize(200, DESKTOP_CAP, 1500)).toBe(2048);
        expect(resolveShadowMapSize(200, DESKTOP_CAP, 700)).toBe(512);
    });

    it('explicit sizes still respect the device cap and floor', () => {
        expect(resolveShadowMapSize(200, MOBILE_CAP, 4096)).toBe(2048); // mobile cap guards the silent-alloc failure
        expect(resolveShadowMapSize(200, DESKTOP_CAP, 8192)).toBe(4096);
        expect(resolveShadowMapSize(200, DESKTOP_CAP, 100)).toBe(512);
    });

    it('non-finite explicit values fall back to derived sizing', () => {
        expect(resolveShadowMapSize(200, DESKTOP_CAP, Number.NaN)).toBe(4096);
        expect(resolveShadowMapSize(200, MOBILE_CAP, Number.POSITIVE_INFINITY)).toBe(2048);
    });
});

describe('configureDirectionalShadow resizing a live shadow map', () => {
    const config = (): ShadowConfig => ({
        mapSize: 0,
        mapSizeOverride: 512,
        bias: 0,
        normalBias: 0,
        shadowBlurRadius: 1,
        shadowDistance: DEFAULT_SHADOW_DISTANCE,
    });

    /** A sun whose shadow map was already allocated at a different size. */
    function litSun(): { light: THREE.DirectionalLight; dispose: jest.Mock; map: THREE.WebGLRenderTarget } {
        const light = new THREE.DirectionalLight();
        const dispose = jest.fn();
        const map = { dispose } as unknown as THREE.WebGLRenderTarget;
        light.shadow.map = map;
        light.shadow.mapSize.set(2048, 2048);
        return { light, dispose, map };
    }

    const renderer = (): THREE.WebGLRenderer => ({ shadowMap: {} }) as unknown as THREE.WebGLRenderer;

    afterEach(() => setActiveRendererType('webgl'));

    it('drops the stale target under WebGLRenderer, which only allocates while map is null', () => {
        setActiveRendererType('webgl');
        const { light, dispose } = litSun();

        configureDirectionalShadow(renderer(), light, config());

        expect(dispose).toHaveBeenCalled();
        expect(light.shadow.map).toBeNull();
        expect(light.shadow.mapSize.width).toBe(512);
    });

    it('keeps an allocated map at its size under WebGPURenderer — a resize strands bind groups on the destroyed texture', () => {
        setActiveRendererType('webgpu');
        const { light, dispose, map } = litSun();
        const cfg = config();

        const unitsPerTexel = configureDirectionalShadow(renderer(), light, cfg);

        expect(dispose).not.toHaveBeenCalled();
        expect(light.shadow.map).toBe(map);
        expect(light.shadow.mapSize.width).toBe(2048);
        // getShadowConfig() and texel snapping describe the map that actually exists.
        expect(cfg.mapSize).toBe(2048);
        expect(unitsPerTexel).toBeCloseTo((2 * DEFAULT_SHADOW_DISTANCE) / 2048, 6);
    });

    it('sizes a not-yet-allocated map under WebGPURenderer as asked', () => {
        setActiveRendererType('webgpu');
        const light = new THREE.DirectionalLight();

        configureDirectionalShadow(renderer(), light, config());

        expect(light.shadow.mapSize.width).toBe(512);
    });
});
