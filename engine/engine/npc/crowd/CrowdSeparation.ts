/**
 * CrowdSeparation — position-based separation for crowd agents.
 *
 * Keeps agents from overlapping by PROJECTING them apart, not by applying
 * forces. For each overlapping pair the pass moves both agents along their
 * centre line until they just touch, splitting the correction by weight. A few
 * Gauss-Seidel sweeps converge; there is no velocity, no accumulated impulse and
 * no stiffness constant, so the pass cannot oscillate, overshoot or explode
 * however densely agents are packed. That is the property that matters for a
 * horde funnelling into a doorway, where a spring-based separation would ring.
 *
 * This replaces the per-agent physics scene query (PhysicsWorld.
 * computeGroupAvoidance) for crowd NPCs. That query cost a broad-phase traversal
 * of the whole collider set per agent, which is why the scheduler rationed
 * avoidance to a handful of agents per frame; this costs a few float operations
 * per nearby pair, so it can run for every agent every frame.
 *
 * Agents are discs on the ground plane. Vertical separation is deliberately not
 * modelled here — see SpatialHash.
 */
import type { SpatialHash } from 'engine/npc/crowd/SpatialHash.js';

/** Tuning for one separation pass. */
export interface SeparationOptions {
    /**
     * Gauss-Seidel sweeps. 1 resolves most overlap; 2 is visibly tighter in
     * dense packing; beyond that returns diminish sharply because each sweep
     * already sees the previous sweep's corrections.
     */
    iterations: number;
    /**
     * Fraction of each overlap corrected per sweep, 0..1. Below 1 the pass
     * relaxes toward separation over several frames instead of snapping, which
     * reads as agents settling rather than popping apart.
     */
    stiffness: number;
    /**
     * Overlap (m) tolerated before any correction. A small slack stops agents
     * jittering against each other when they are legitimately shoulder to
     * shoulder.
     */
    slack: number;
}

export const DEFAULT_SEPARATION_OPTIONS: SeparationOptions = {
    iterations: 2,
    stiffness: 0.5,
    slack: 0.02,
};

/**
 * Agent state the pass reads and writes, as parallel arrays.
 *
 * Structure-of-arrays rather than objects: the pass touches x/z/radius/mobility
 * for thousands of agents per frame, and array-of-structs would chase a pointer
 * per agent.
 *
 * `mobility` is how freely an agent is DISPLACED by a correction — an inverse
 * mass, not a mass. 0 is immovable and absorbs none of the overlap (the player,
 * who must never be shoved by the horde); 1 is an ordinary crowd agent. Giving
 * near-player FULL-tier agents a lower mobility than distant VIRTUAL ones makes
 * the ones you are looking at hold their ground while the crowd behind yields.
 *
 * Naming this "weight" invites the opposite reading — that a big number resists
 * being pushed — which silently inverts every interaction.
 */
export interface CrowdAgentArrays {
    xs: Float32Array;
    zs: Float32Array;
    radii: Float32Array;
    mobilities: Float32Array;
    count: number;
}

/**
 * Push overlapping agents apart, in place.
 *
 * `hash` must already be built over the same `xs`/`zs` arrays. Positions are
 * mutated as the pass runs and the hash reads them live, so later agents in a
 * sweep see earlier corrections (Gauss-Seidel). Returns the number of pairs
 * corrected on the final sweep — zero means the crowd is fully separated, which
 * the caller can use to skip further work or to report convergence.
 */
export function separateCrowd(
    agents: CrowdAgentArrays,
    hash: SpatialHash,
    options: SeparationOptions = DEFAULT_SEPARATION_OPTIONS,
): number {
    const { xs, zs, radii, mobilities, count } = agents;
    if (count < 2) return 0;

    const iterations = Math.max(1, options.iterations | 0);
    const stiffness = Math.min(1, Math.max(0, options.stiffness));
    const slack = Math.max(0, options.slack);

    // Query radius must cover the widest pair that could overlap. Sizing from
    // the largest radius (rather than per-agent) keeps the 3x3 cell scan valid
    // for every agent regardless of who it meets.
    let maxRadius = 0;
    for (let i = 0; i < count; i++) if (radii[i]! > maxRadius) maxRadius = radii[i]!;
    const queryRadius = maxRadius * 2;

    let corrections = 0;
    for (let iter = 0; iter < iterations; iter++) {
        corrections = 0;
        for (let i = 0; i < count; i++) {
            const mi = mobilities[i]!;
            const ri = radii[i]!;
            hash.forEachNeighbor(i, queryRadius, (j) => {
                // Each unordered pair is visited twice (once from each side).
                // Handling only i<j halves the work and keeps the correction
                // symmetric — resolving the same pair twice per sweep would
                // double its effective stiffness.
                if (j < i) return;
                const mj = mobilities[j]!;
                const msum = mi + mj;
                if (msum <= 0) return; // both immovable: nothing can resolve

                const dx = xs[j]! - xs[i]!;
                const dz = zs[j]! - zs[i]!;
                const minDist = ri + radii[j]!;
                const d2 = dx * dx + dz * dz;
                if (d2 >= (minDist - slack) * (minDist - slack)) return;

                let nx: number;
                let nz: number;
                let d: number;
                if (d2 > 1e-8) {
                    d = Math.sqrt(d2);
                    nx = dx / d;
                    nz = dz / d;
                } else {
                    // Exactly coincident: no separating axis exists, so pick a
                    // deterministic one. Deriving it from the index keeps the
                    // result reproducible frame to frame (a random axis would
                    // make coincident agents shiver) and spreads a stack of
                    // agents out radially rather than along one line.
                    const angle = (i * 2.399963) % (Math.PI * 2);
                    d = 0;
                    nx = Math.cos(angle);
                    nz = Math.sin(angle);
                }

                const overlap = (minDist - d) * stiffness;
                // Split by each agent's OWN mobility: an immovable agent
                // (mobility 0) absorbs none of the correction and its
                // neighbour takes all of it.
                const shareI = mi / msum;
                const shareJ = mj / msum;
                xs[i]! -= nx * overlap * shareI;
                zs[i]! -= nz * overlap * shareI;
                xs[j]! += nx * overlap * shareJ;
                zs[j]! += nz * overlap * shareJ;
                corrections++;
            });
        }
        // Fully separated — later sweeps would find nothing.
        if (corrections === 0) break;
    }
    return corrections;
}
