/**
 * Which half of a Gaussian-splat scene is on screen: the photographic splat, the voxel
 * geometry derived from it, or both.
 *
 * A splat scene carries two representations of the same place — the splat a player sees and
 * the voxel/collider grid they actually walk on — and the only way to tell whether they line
 * up is to look at each alone. That is a DIAGNOSTIC, so it lives here rather than in a genre:
 * every voxel template used to carry a byte-identical copy of this logic bound to the `V` key,
 * written for a `gaussiansplat` genre that no longer exists, and shipped it to players who have
 * no reason to press V.
 *
 * Reached the way the engine's other developer overrides are reached — `?splats=`, alongside
 * `?lod=` (LevelDetail.ts), `?dpr=` (RenderPixelRatio.ts), `?warmup=` (WarmupPolicy.ts),
 * `?matq=` (MaterialQuality.ts) and
 * `?weather=` — plus `window.__bmDebug.setSplatViewMode()` for changing it without a reload,
 * which is what "does the collider match the splat" actually needs.
 *
 * Engine-owned rather than editor-owned, following `debug/PvsController.ts` — the same
 * extraction, already done once for the sibling PVS subsystem: state that outlives an editor
 * session belongs to `GameEngine`, and everything it touches arrives through provider
 * callbacks so this file stays agnostic about whether a splat exists at all.
 */

import type * as THREE from 'three';

export type SplatViewMode = 'both' | 'splats' | 'voxels';

export const DEFAULT_SPLAT_VIEW_MODE: SplatViewMode = 'both';

const MODES: readonly SplatViewMode[] = ['both', 'splats', 'voxels'];

/** Narrowing guard, exported so `BmDebug` can reject a bad argument with the same rule. */
export function isSplatViewMode(value: unknown): value is SplatViewMode {
    return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/**
 * `?splats=both|splats|voxels`, defaulting to `both` — a game must never load with half its
 * world hidden because nobody passed a parameter.
 *
 * Tolerant like every sibling reader: an unrecognised value warns and falls back rather than
 * throwing, because this is typed by hand into a URL bar. Returns the default with no `window`
 * (tests, workers).
 */
export function resolveSplatViewMode(): SplatViewMode {
    try {
        const raw = new URLSearchParams(window.location.search).get('splats');
        if (raw === null) return DEFAULT_SPLAT_VIEW_MODE;
        if (isSplatViewMode(raw)) return raw;
        console.warn(
            `[splats] Ignoring ?splats=${raw} — expected one of ${MODES.join(', ')}. Using ${DEFAULT_SPLAT_VIEW_MODE}.`,
        );
        return DEFAULT_SPLAT_VIEW_MODE;
    } catch {
        return DEFAULT_SPLAT_VIEW_MODE;
    }
}

/** The bits of a splat renderer this controller drives. Structural, so tests need no engine. */
export interface SplatViewRenderer {
    setSplatVisibility?(visible: boolean): void;
}

/** The bit of the collider editor this controller drives. */
export interface SplatViewColliderEditor {
    setVoxelsVisible?(visible: boolean): void;
}

export interface SplatViewDeps {
    /** The scene's WorldGroup — terrain, fluid, environment objects and VoxelObjects. */
    getWorldGroup(): THREE.Object3D | null;
    /** Every loaded splat renderer, so a multi-splat scene switches as one. */
    getRenderers(): SplatViewRenderer[];
    /**
     * The shared collider editor, which owns one `VoxelWorld` per splat. Those add their chunk
     * meshes straight to the scene rather than under WorldGroup, so hiding the group does not
     * reach them — they need this second call.
     */
    getColliderEditor(): SplatViewColliderEditor | null;
}

/**
 * Applies a {@link SplatViewMode} across every surface that has to agree about it.
 *
 * `refresh()` is idempotent and safe before anything has loaded, which is what lets the engine
 * call it again after each renderer appears instead of tracking whether it already ran.
 */
export class SplatViewController {
    private mode: SplatViewMode;

    constructor(private readonly deps: SplatViewDeps, mode: SplatViewMode = resolveSplatViewMode()) {
        this.mode = mode;
    }

    getMode(): SplatViewMode {
        return this.mode;
    }

    setMode(mode: SplatViewMode): void {
        this.mode = mode;
        this.refresh();
    }

    /** Whether any splat is currently loaded — see {@link activeSplatViewController}. */
    hasSplats(): boolean {
        return this.deps.getRenderers().length > 0;
    }

    /** Re-assert the current mode. Call after a renderer is added. */
    refresh(): void {
        const showVoxels = this.mode === 'voxels' || this.mode === 'both';
        const showSplats = this.mode === 'splats' || this.mode === 'both';

        const world = this.deps.getWorldGroup();
        if (world) world.visible = showVoxels;

        const colliderEditor = this.deps.getColliderEditor();
        colliderEditor?.setVoxelsVisible?.(showVoxels);

        for (const renderer of this.deps.getRenderers()) {
            renderer?.setSplatVisibility?.(showSplats);
        }
    }
}

/**
 * The page's controller, if a splat scene has built one.
 *
 * A module singleton rather than a `GameEngine` field, for the two reasons the neighbouring
 * `getGameEventLog()` / `getObjectIdService()` singletons exist: it keeps `GameEngine` (already
 * at its 2000-line ceiling) down to one call per splat event, and it lets `BmDebug` read the
 * mode without importing `GameEngine` — the property that file's header claims and that keeps
 * `__bmDebug` answering before any game has loaded. One engine per page, like those two.
 */
let active: SplatViewController | null = null;

/** Build the controller on the first splat, or return the one already serving this page. */
export function ensureSplatViewController(deps: SplatViewDeps): SplatViewController {
    if (!active) active = new SplatViewController(deps);
    return active;
}

/**
 * Re-assert the mode. Called after every splat renderer registers, because each one starts
 * visible and would otherwise ignore a mode chosen before it existed. A no-op with no splat.
 */
export function refreshSplatView(): void {
    active?.refresh();
}

/**
 * The controller, or null when this page has no splat *right now*.
 *
 * Derived from the live renderer list rather than from an explicit teardown call, so a scene
 * whose splats were disposed reports "no splat" without `GameEngine` having to remember to say
 * so. `__bmDebug.getSplatViewMode()` reads this.
 */
export function activeSplatViewController(): SplatViewController | null {
    return active && active.hasSplats() ? active : null;
}
