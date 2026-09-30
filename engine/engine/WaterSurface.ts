import * as THREE from 'three';
import { createWaterMaterial } from 'engine/shaders/WaterMaterial.js';
import { addCoastalDepthAttribute, type CoastalHeightAt } from 'engine/water/CoastalDepthField.js';

export type CoastalSunDirection = THREE.Vector3 | null | (() => THREE.Vector3 | null);

/**
 * Coastal water: build ONE transparent, animated water-surface plane at
 * `waterLevelY` spanning the whole level. The higher land terrain occludes it
 * and the carved water basins below it reveal the see-through sea over the
 * voxelized seafloor — so no per-zone clipping is needed.
 *
 * Pure builder extracted from GameEngine (max-lines cap): the engine passes
 * the loaded level's bounds + sun and owns the returned mesh's lifecycle.
 */
export function buildWaterSurfaceMesh(
    waterLevelY: number,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    sunPosition: CoastalSunDirection,
    heightAt?: CoastalHeightAt,
): THREE.Mesh {
    // Size + centre the plane to the ACTUAL loaded level extent (the terrain
    // bounds — the worldProfile groundWorldSize is a different unit). 5%
    // margin so it fully covers the edges.
    const sizeX = Math.max(16, (bounds.maxX - bounds.minX) * 1.05);
    const sizeZ = Math.max(16, (bounds.maxZ - bounds.minZ) * 1.05);
    // ~4 m facets: the shortest wave band is ~11 m, and the flat-shaded wave look needs
    // several facets per wavelength (the old 12 m facets left ~2 per chop wave — the
    // displacement existed but was unresolvable). Cap at ~51k triangles per surface.
    const segX = Math.min(160, Math.max(24, Math.round(sizeX / 4)));
    const segZ = Math.min(160, Math.max(24, Math.round(sizeZ / 4)));
    const geometry = new THREE.PlaneGeometry(sizeX, sizeZ, segX, segZ);
    addCoastalDepthAttribute(geometry, (bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2, waterLevelY, heightAt);
    const { material, setTime, setSunDirection } = createWaterMaterial(undefined, { bathymetry: true });
    // Line the specular glints up with the level's actual sun.
    const updateSun = (): void => {
        const direction = typeof sunPosition === 'function' ? sunPosition() : sunPosition;
        if (direction) setSunDirection(direction);
    };
    updateSun();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'WaterSurface';
    mesh.rotation.x = -Math.PI / 2; // lay the XY plane flat; its local +z becomes world up
    mesh.position.set((bounds.minX + bounds.maxX) / 2, waterLevelY, (bounds.minZ + bounds.maxZ) / 2);
    mesh.renderOrder = 10;          // draw after opaque geometry
    mesh.frustumCulled = false;     // a level-spanning plane is always relevant
    // Own time base, deliberately not the engine's shared clock: this runs from
    // onBeforeRender, i.e. mid-frame, and THREE's clock readers are destructive
    // (see engine/FrameTimer.ts). A plain performance.now() baseline is the same
    // "seconds since built" value without a clock to steal from — and without
    // THREE.Clock's r183 deprecation warning.
    const builtAtMs = performance.now();
    mesh.onBeforeRender = (): void => { setTime((performance.now() - builtAtMs) / 1000); if (typeof sunPosition === 'function') updateSun(); };
    return mesh;
}
