import { getVoxelTextureAtlas, type VoxelTextureAtlas } from 'engine/VoxelTextureAtlas.js';
import type { CustomBlockType, WorldProfileData } from 'types/game.js';

export interface BlockLoadReport {
    loaded: string[];
    failed: Array<{ name: string; reason: string }>;
    skipped: Array<{ name: string; reason: 'duplicate' | 'invalid' }>;
}

export type BlockResolveResult =
    | { id: number }
    | { id: undefined; reason: 'not-in-world-json' | 'load-failed' | 'invalid-name' };

/** Trim a textureUrl for log output — the `solidColor` synthesis path produces
 *  full PNG data URLs that swamp the console otherwise. */
function shortUrl(url: string): string {
    return url.length > 80 ? `${url.slice(0, 80)}…(${url.length} chars)` : url;
}

export class BlockRegistry {
    private explicitAtlas: VoxelTextureAtlas | null;
    /** Per-load failure reasons, keyed by lowercase name (matches atlas lookup). */
    private failureReasons = new Map<string, string>();
    /** Names declared in `worldProfileData.customBlockTypes` for the current load,
     *  so `resolve()` can distinguish "wasn't in world.json" from "was, but failed to load". */
    private declaredNames = new Set<string>();

    /** Atlas is resolved lazily so the registry can be constructed up-front
     *  without triggering atlas initialization for non-voxel genres. */
    constructor(atlas?: VoxelTextureAtlas) {
        this.explicitAtlas = atlas ?? null;
    }

    private get atlas(): VoxelTextureAtlas {
        return this.explicitAtlas ?? getVoxelTextureAtlas();
    }

    /**
     * Load `worldProfileData.customBlockTypes` into the atlas. Never throws —
     * each failure is captured in the returned report and tracked internally
     * so `resolve()` can later report a load-failure cause instead of a
     * generic "not registered". Idempotent: blocks already registered in the
     * atlas are skipped without re-fetching.
     *
     * Call once per `loadGame`, BEFORE the genre's WorldGenerator runs. NOT
     * concurrency-safe — `failureReasons` and `declaredNames` are reset at
     * the start, so two overlapping calls would clobber each other.
     */
    async loadFromWorldProfile(profile: WorldProfileData): Promise<BlockLoadReport> {
        this.failureReasons.clear();
        this.declaredNames.clear();
        const report: BlockLoadReport = { loaded: [], failed: [], skipped: [] };

        const specs = profile.customBlockTypes ?? [];
        if (specs.length === 0) return report;

        console.log(`[BlockRegistry] Loading ${specs.length} custom block type(s) from world.json`);

        const seen = new Set<string>();
        const tasks: Promise<void>[] = [];

        for (const spec of specs) {
            if (!spec || typeof spec.name !== 'string' || !spec.name) {
                report.skipped.push({ name: String(spec?.name ?? '<unnamed>'), reason: 'invalid' });
                continue;
            }
            const lower = spec.name.toLowerCase();
            this.declaredNames.add(lower);

            if (seen.has(lower)) {
                report.skipped.push({ name: spec.name, reason: 'duplicate' });
                continue;
            }
            seen.add(lower);

            if (this.atlas.getBlockIdByName(spec.name) !== undefined) {
                report.loaded.push(spec.name);
                continue;
            }

            tasks.push(this.registerOne(spec, report));
        }

        await Promise.all(tasks);

        if (report.loaded.length > 0) {
            console.log(`[BlockRegistry] Registered ${report.loaded.length} custom block(s):`, report.loaded);
        }
        if (report.failed.length > 0) {
            console.warn(
                `[BlockRegistry] ${report.failed.length}/${specs.length} custom block(s) failed to load:`,
                report.failed,
            );
        }
        return report;
    }

    /** Push a spec to the atlas. Returns the assigned id, or null on failure
     *  (with the cause already recorded in `failureReasons`). */
    private async registerSpec(spec: CustomBlockType, errLogPrefix: string): Promise<number | null> {
        const properties: { isFluid?: boolean; opacity?: number } = {};
        if (spec.isFluid !== undefined) properties.isFluid = spec.isFluid;
        if (spec.opacity !== undefined) properties.opacity = spec.opacity;
        try {
            const blockId = await this.atlas.registerBlockTextureFromUrl({
                name: spec.name,
                textureUrl: spec.textureUrl,
                sideTextureUrl: spec.sideTextureUrl ?? undefined,
                textureSize: spec.textureSize || 64,
                properties: Object.keys(properties).length > 0 ? properties : undefined,
            });
            this.atlas.registerBlockName(spec.name, blockId);
            return blockId;
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            this.failureReasons.set(spec.name.toLowerCase(), reason);
            console.error(`${errLogPrefix} '${spec.name}' (url=${shortUrl(spec.textureUrl)}):`, err);
            return null;
        }
    }

    private async registerOne(spec: CustomBlockType, report: BlockLoadReport): Promise<void> {
        const blockId = await this.registerSpec(spec, '[BlockRegistry] Failed to register');
        if (blockId !== null) {
            report.loaded.push(spec.name);
        } else {
            report.failed.push({ name: spec.name, reason: this.failureReasons.get(spec.name.toLowerCase()) ?? 'unknown' });
        }
    }

    /**
     * Register a single custom block at runtime — used by the live WS handler
     * (`REGISTER_CUSTOM_BLOCK_TYPE`) so persisted-vs-live registrations share
     * a single code path. Idempotent: returns `{ id, alreadyExisted: true }`
     * if the name is already in the atlas. Returns `{ error }` instead of
     * throwing.
     */
    async registerCustom(
        spec: CustomBlockType,
    ): Promise<{ id: number; alreadyExisted: boolean } | { error: string }> {
        const existing = this.atlas.getBlockIdByName(spec.name);
        if (existing !== undefined) {
            return { id: existing, alreadyExisted: true };
        }
        const blockId = await this.registerSpec(spec, '[BlockRegistry] registerCustom failed for');
        if (blockId === null) {
            return { error: this.failureReasons.get(spec.name.toLowerCase()) ?? 'unknown' };
        }
        const lower = spec.name.toLowerCase();
        this.declaredNames.add(lower);
        this.failureReasons.delete(lower);
        return { id: blockId, alreadyExisted: false };
    }

    /**
     * Resolve a block-type name into a discriminated result. Distinguishes
     * "name isn't in world.json" from "name is, but its texture failed to
     * load" so callers can surface an actionable warning.
     */
    resolve(name: string | undefined): BlockResolveResult {
        if (!name || typeof name !== 'string') {
            return { id: undefined, reason: 'invalid-name' };
        }
        // Atlas ids start at 1 (`BlockType.NONE === 0` is reserved). The `> 0`
        // guard rejects the reserved id explicitly so callers don't accidentally
        // treat NONE as a registered block.
        const id = this.atlas.getBlockIdByName(name);
        if (id !== undefined && id > 0) {
            return { id };
        }
        // Every entry that lands in failureReasons was first declared, so checking
        // declaredNames alone is sufficient. The map is kept around for the
        // resolution-failure log to surface the underlying cause.
        if (this.declaredNames.has(name.toLowerCase())) {
            return { id: undefined, reason: 'load-failed' };
        }
        return { id: undefined, reason: 'not-in-world-json' };
    }

    /**
     * Convenience for fixed-fallback override sites: returns the resolved id,
     * or `fallbackId` when resolution fails. Emits a structured warning
     * describing the actual cause (load failed vs not registered vs invalid
     * name). `ctx` is included in the log to help locate the call site.
     */
    resolveOrFallback(name: string | undefined, fallbackId: number, ctx?: string): number {
        if (!name) return fallbackId;
        const r = this.resolve(name);
        if (r.id !== undefined) return r.id;
        this.logResolutionFailure(name, r.reason, ctx);
        return fallbackId;
    }

    /**
     * Variant for sites where the fallback isn't a fixed id (e.g., per-cell
     * procedural defaults computed inside a generation loop). Returns the
     * resolved id, or `undefined` so the caller can use its own fallback
     * path. Emits the same structured warning as `resolveOrFallback`.
     */
    resolveOptional(name: string | undefined, ctx?: string): number | undefined {
        if (!name) return undefined;
        const r = this.resolve(name);
        if (r.id !== undefined) return r.id;
        this.logResolutionFailure(name, r.reason, ctx);
        return undefined;
    }

    /** Last-load failure reason for `name`, or undefined if it loaded fine / wasn't declared. */
    getFailureReason(name: string): string | undefined {
        return this.failureReasons.get(name.toLowerCase());
    }

    private logResolutionFailure(
        name: string,
        reason: 'not-in-world-json' | 'load-failed' | 'invalid-name',
        ctx?: string,
    ): void {
        const where = ctx ? ` (${ctx})` : '';
        if (reason === 'load-failed') {
            const detail = this.failureReasons.get(name.toLowerCase()) ?? 'unknown texture-load error';
            console.warn(
                `[BlockRegistry] Block '${name}'${where} is in world.json but its texture failed to load: ${detail}. Falling back.`,
            );
        } else if (reason === 'not-in-world-json') {
            console.warn(
                `[BlockRegistry] Block '${name}'${where} is not registered. Create it via generateBlockTypeTool. Falling back.`,
            );
        } else {
            console.warn(`[BlockRegistry] Invalid block name '${name}'${where}. Falling back.`);
        }
    }
}
