/**
 * CrowdSolver — one pass per frame that keeps crowd characters from overlapping.
 *
 * This is the local half of the two-layer crowd model: the goal field answers
 * "where do I go", this answers "don't stand inside my neighbour". It exists
 * because nothing else did — the engine's two `computeGroupAvoidance` call sites
 * avoid PROPS/VEHICLES and the PLAYER respectively, so NPCs could always walk
 * through one another, and a horde converging on a shared goal field arrives as
 * a single stack of overlapping bodies.
 *
 * It is deliberately NOT physics. Agents are discs projected apart on the ground
 * plane; the correction is positional, so it cannot oscillate or add energy, and
 * it costs a few float operations per nearby pair instead of a broad-phase query
 * per agent. That is what lets it run for every agent every frame rather than
 * the eight per frame the scheduler could previously afford.
 *
 * Order within a frame matters: run AFTER behaviours have moved their agents and
 * BEFORE transforms are consumed, so the frame that renders is the separated one.
 */
import { SpatialHash, CELL_SIZE_RADIUS_MULTIPLE } from 'engine/npc/crowd/SpatialHash.js';
import { separateCrowd, DEFAULT_SEPARATION_OPTIONS } from 'engine/npc/crowd/CrowdSeparation.js';
import type { SeparationOptions } from 'engine/npc/crowd/CrowdSeparation.js';
import type { CrowdRegistry } from 'engine/npc/crowd/CrowdAgents.js';

/** What one solve did, for the debug HUD and for tests. */
export interface CrowdSolveResult {
    /** Agents gathered this frame (active members only). */
    agents: number;
    /** Overlapping pairs corrected on the final sweep; 0 means fully separated. */
    corrections: number;
    /** Members handed a non-zero offset. */
    moved: number;
}

const EMPTY_RESULT: CrowdSolveResult = { agents: 0, corrections: 0, moved: 0 };

/**
 * Solve one frame of crowd separation.
 *
 * The grid is sized from the LARGEST agent radius rather than per agent, because
 * the neighbour scan only visits the 3x3 block around a cell — a cell smaller
 * than the widest interaction distance would silently miss pairs. Sizing it once
 * per solve keeps that guarantee while adapting to whatever mix of radii the
 * game actually registered.
 */
export class CrowdSolver {
    private hash = new SpatialHash(1);
    private lastResult: CrowdSolveResult = EMPTY_RESULT;

    solve(registry: CrowdRegistry, options: SeparationOptions = DEFAULT_SEPARATION_OPTIONS): CrowdSolveResult {
        const count = registry.gather();
        if (count < 2) {
            // One agent cannot overlap anything; skip the grid build entirely.
            this.lastResult = { agents: count, corrections: 0, moved: 0 };
            return this.lastResult;
        }

        let maxRadius = 0;
        for (let i = 0; i < count; i++) {
            const r = registry.radii[i]!;
            if (r > maxRadius) maxRadius = r;
        }
        this.hash.setCellSize(Math.max(1e-3, maxRadius * CELL_SIZE_RADIUS_MULTIPLE * 2));
        this.hash.build(registry.xs, registry.zs, count);

        const corrections = separateCrowd(
            { xs: registry.xs, zs: registry.zs, radii: registry.radii, mobilities: registry.mobilities, count },
            this.hash,
            options,
        );
        const moved = registry.scatter();
        this.lastResult = { agents: count, corrections, moved };
        return this.lastResult;
    }

    /** Most recent solve, for the debug HUD. */
    getLastResult(): CrowdSolveResult {
        return this.lastResult;
    }

    /** One-line summary for the debug panel. */
    getStatsLine(): string {
        const r = this.lastResult;
        return `Crowd: ${r.agents} agents, ${r.corrections} overlaps, ${r.moved} moved`;
    }
}

/** Module-global solver, matching getGlobalCrowd / getGlobalNavMesh. */
let _globalSolver: CrowdSolver | null = null;

export function getGlobalCrowdSolver(): CrowdSolver {
    if (!_globalSolver) _globalSolver = new CrowdSolver();
    return _globalSolver;
}
