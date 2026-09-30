/**
 * CameraFit — shared math for framing a rectangular world in the viewport.
 *
 * Used by both the screenshot service (perspective fit, see ScreenshotCameras.ts)
 * and the live top-down "fit whole world" mode (orthographic fit, see
 * TopDownCamera.ts) so the two never drift apart.
 */

import * as THREE from 'three';

/** Default fit margin: 1.0 = the limiting dimension touches the viewport edges
 *  exactly. Values > 1 add breathing room; < 1 crop inward. */
export const DEFAULT_FIT_LEVEL_MARGIN = 1.0;

/**
 * Perspective fit: the camera altitude above the ground plane at which a
 * `sizeX × sizeZ` world rectangle exactly fills a perspective viewport.
 *
 * @param fovYDeg vertical field-of-view in degrees.
 */
export function fitHeight(
    sizeX: number,
    sizeZ: number,
    aspect: number,
    margin: number,
    fovYDeg: number,
): number {
    const fovY = THREE.MathUtils.degToRad(fovYDeg);
    const fovX = 2 * Math.atan(Math.tan(fovY / 2) * aspect);
    const heightForZ = (sizeZ / 2) / Math.tan(fovY / 2);
    const heightForX = (sizeX / 2) / Math.tan(fovX / 2);
    return Math.max(heightForX, heightForZ) * margin;
}

/** Pixel insets reserved on each edge of the viewport (e.g. for UI panels). */
export interface ViewportInsetsPx {
    left: number;
    right: number;
    top: number;
    bottom: number;
}

/**
 * Orthographic fit for an overhead camera that draws full-canvas but frames the
 * `sizeX × sizeZ` world into a sub-rectangle of the viewport — the area left
 * after subtracting `insetsPx` (e.g. a right-side UI panel). The world is fully
 * visible (no borders cropping it) and centered within that sub-rectangle; the
 * reserved edges show background (where opaque UI is overlaid).
 *
 * Returns the camera's view-space frustum bounds. `sizeX` maps to screen X,
 * `sizeZ` to screen Y (camera looks straight down with `up = (0, 0, -1)`).
 *
 * With all insets 0 this reduces to a plain centered full-viewport fit.
 */
export function computeOrthoFrustumForRegion(
    sizeX: number,
    sizeZ: number,
    viewportWidthPx: number,
    viewportHeightPx: number,
    insetsPx: ViewportInsetsPx,
    margin: number,
): { left: number; right: number; top: number; bottom: number } {
    const W = Math.max(1, viewportWidthPx);
    const H = Math.max(1, viewportHeightPx);
    // Pixel size and center of the map region (viewport minus reserved insets).
    const mapW = Math.max(1, W - insetsPx.left - insetsPx.right);
    const mapH = Math.max(1, H - insetsPx.top - insetsPx.bottom);
    const regionCenterXpx = insetsPx.left + mapW / 2;
    const regionCenterYpx = insetsPx.top + mapH / 2;

    // World units per pixel so the whole world fits the region (larger need wins,
    // letterboxing the other axis). Uniform because orthographic pixels are.
    const unitsPerPx = Math.max(sizeX / mapW, sizeZ / mapH) * margin;

    // Full-canvas frustum extent (the renderer draws the entire viewport).
    const fullW = unitsPerPx * W;
    const fullH = unitsPerPx * H;

    // Shift the frustum so the world center (camera-centered → view-space origin)
    // projects to the region center on screen. Derivation: orthographic maps
    // view-x in [left,right] to screen [0,W]; solving screen_x(0) = regionCenterX
    // gives left = -fullW * regionCenterX / W. Same for Y (screen-up = +view-y).
    const left = -fullW * (regionCenterXpx / W);
    const top = fullH * (regionCenterYpx / H);
    return {
        left,
        right: left + fullW,
        top,
        bottom: top - fullH,
    };
}
