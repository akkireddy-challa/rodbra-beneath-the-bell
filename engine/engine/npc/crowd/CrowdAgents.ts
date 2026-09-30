/**
 * CrowdAgents — the registry of characters the crowd solver moves.
 *
 * Holds agent state as parallel typed arrays rather than as objects, because the
 * solver touches every agent's x/z/radius/mobility once or twice per frame and
 * array-of-structs would chase a pointer per agent. Members are gathered into
 * the arrays at the start of a solve and the resulting corrections are scattered
 * back at the end; in between, nothing in the solver knows what an agent IS.
 *
 * Registration is by member reference, and removal is a swap-with-last, so a
 * despawn costs O(1) and never leaves a hole for the solver to skip.
 */

/**
 * What the solver needs from a character, and the only surface it touches.
 *
 * Kept deliberately narrow so the solver stays testable with plain fakes: no
 * physics, no navmesh, no Object3D. `applyCrowdSeparation` receives a DELTA
 * rather than an absolute position so the member decides how to apply it —
 * a body-owning agent translates its kinematic body, a bodyless VIRTUAL agent
 * moves its visual, and an agent that has since died can ignore it.
 */
export interface CrowdMember {
    /** Current ground-plane position. */
    getCrowdX(): number;
    getCrowdZ(): number;
    /** Disc radius used for separation, in metres. */
    getCrowdRadius(): number;
    /**
     * How freely this agent is displaced: 0 immovable, 1 ordinary. An inverse
     * mass, not a mass — see CrowdSeparation.
     */
    getCrowdMobility(): number;
    /** Apply a solved separation offset. */
    applyCrowdSeparation(dx: number, dz: number): void;
    /** False while dead, hibernating or otherwise not participating this frame. */
    isCrowdActive(): boolean;
}

export class CrowdRegistry {
    private members: CrowdMember[] = [];
    /** Index of each member in `members`, for O(1) removal. */
    private indexOf = new Map<CrowdMember, number>();

    // Gathered state. Capacity grows; `count` is the live prefix.
    xs = new Float32Array(0);
    zs = new Float32Array(0);
    radii = new Float32Array(0);
    mobilities = new Float32Array(0);
    count = 0;
    /** Members parallel to the gathered arrays, for scatter. */
    private gathered: CrowdMember[] = [];
    /** Positions as gathered, so scatter can send a delta rather than an absolute. */
    private preX = new Float32Array(0);
    private preZ = new Float32Array(0);

    add(member: CrowdMember): void {
        if (this.indexOf.has(member)) return;
        this.indexOf.set(member, this.members.length);
        this.members.push(member);
    }

    remove(member: CrowdMember): void {
        const i = this.indexOf.get(member);
        if (i === undefined) return;
        const last = this.members.length - 1;
        if (i !== last) {
            const moved = this.members[last]!;
            this.members[i] = moved;
            this.indexOf.set(moved, i);
        }
        this.members.pop();
        this.indexOf.delete(member);
    }

    /** Registered members, active or not. */
    size(): number {
        return this.members.length;
    }

    /**
     * Copy the active members' live state into the solver arrays. Inactive
     * members are skipped entirely rather than pinned, so a hibernating horde
     * costs nothing here beyond the isCrowdActive() call — which is the whole
     * point of hibernating it.
     */
    gather(): number {
        const cap = this.members.length;
        if (this.xs.length < cap) {
            this.xs = new Float32Array(cap);
            this.zs = new Float32Array(cap);
            this.radii = new Float32Array(cap);
            this.mobilities = new Float32Array(cap);
            this.preX = new Float32Array(cap);
            this.preZ = new Float32Array(cap);
        }
        this.gathered.length = 0;
        let n = 0;
        for (const m of this.members) {
            if (!m.isCrowdActive()) continue;
            const x = m.getCrowdX();
            const z = m.getCrowdZ();
            this.xs[n] = x;
            this.zs[n] = z;
            this.preX[n] = x;
            this.preZ[n] = z;
            this.radii[n] = m.getCrowdRadius();
            this.mobilities[n] = m.getCrowdMobility();
            this.gathered.push(m);
            n++;
        }
        this.count = n;
        return n;
    }

    /**
     * Hand each gathered member the offset the solver applied to it. Members
     * whose position did not change are skipped, so a separated crowd costs no
     * write-backs at all.
     */
    scatter(epsilon = 1e-5): number {
        let moved = 0;
        for (let i = 0; i < this.count; i++) {
            const dx = this.xs[i]! - this.preX[i]!;
            const dz = this.zs[i]! - this.preZ[i]!;
            if (Math.abs(dx) < epsilon && Math.abs(dz) < epsilon) continue;
            this.gathered[i]!.applyCrowdSeparation(dx, dz);
            moved++;
        }
        return moved;
    }

    /** Drop every member. Used on level switch / engine dispose. */
    clear(): void {
        this.members.length = 0;
        this.gathered.length = 0;
        this.indexOf.clear();
        this.count = 0;
    }
}

/**
 * Module-global registry, matching how the navmesh and goal fields are reached
 * (`getGlobalNavMesh`, `getGlobalGoalFields`). One crowd per running game;
 * worlds with several concurrent crowds are not a supported scenario.
 */
let _globalCrowd: CrowdRegistry | null = null;

export function getGlobalCrowd(): CrowdRegistry {
    if (!_globalCrowd) _globalCrowd = new CrowdRegistry();
    return _globalCrowd;
}
