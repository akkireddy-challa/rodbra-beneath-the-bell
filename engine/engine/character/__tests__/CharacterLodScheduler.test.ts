import * as THREE from 'three';
import {
    CharacterLodScheduler, DEFAULT_CHARACTER_LOD, SimClass,
    type LodManagedCharacter, type CharacterLodState,
    getGlobalLodScheduler, disposeGlobalLodScheduler,
} from 'engine/character/CharacterLodScheduler.js';

function makeChar(x: number, z: number, importance: 'hero' | 'crowd'): LodManagedCharacter & { pos: THREE.Vector3 } {
    const pos = new THREE.Vector3(x, 0, z);
    return {
        pos,
        getPosition: () => pos,
        getImportance: () => importance,
        isDeadOrRagdolled: () => false,
        hasActiveGoal: () => true,
        lodState: null as unknown as CharacterLodState,
        onLodChanged: undefined,
    };
}

function makeCamera(): THREE.PerspectiveCamera {
    const cam = new THREE.PerspectiveCamera(75, 1.6, 0.1, 1000);
    cam.position.set(0, 2, 0);
    cam.lookAt(0, 2, 10); // looking toward +Z
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    return cam;
}

/** Register chars on a scheduler and run N evaluate frames. */
function run(s: CharacterLodScheduler, chars: LodManagedCharacter[], cam: THREE.Camera, frames: number): void {
    for (const c of chars) s.registerCharacter(c);   // idempotent
    for (let i = 0; i < frames; i++) s.evaluate(cam, 1 / 60);
}

describe('CharacterLodScheduler', () => {
    afterEach(() => disposeGlobalLodScheduler());

    test('ring assignment by distance, on-frustum', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const near = makeChar(0, 10, 'crowd');   // 10 m ahead -> R0
        const mid = makeChar(0, 40, 'crowd');    // 40 m -> R1
        const far = makeChar(0, 200, 'crowd');   // 200 m -> R2
        run(s, [near, mid, far], cam, 15);
        expect(near.lodState.ring).toBe(0);
        expect(mid.lodState.ring).toBe(1);
        expect(far.lodState.ring).toBe(2);
        // distRing mirrors ring while on-frustum — far means far, near means near.
        expect(near.lodState.distRing).toBe(0);
        expect(far.lodState.distRing).toBe(2);
    });

    test('off-frustum forces the EFFECTIVE ring to 2 (cosmetic) but sim class stays distance-based', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const behind = makeChar(0, -10, 'crowd'); // 10 m BEHIND camera
        run(s, [behind], cam, 15);
        // Effective ring reads 2 for cosmetic gates (anim pause, nameplates)...
        expect(behind.lodState.ring).toBe(2);
        expect(behind.lodState.onFrustum).toBe(false);
        // ...but the frustum must never disembody: sim class follows distance.
        expect(behind.lodState.simClass).toBe(SimClass.FULL);
        // ...and the stamped DISTANCE ring stays 0, because lifecycle decisions
        // key off it. NpcController's hibernation parking used the EFFECTIVE
        // ring here and froze every off-screen guard NPC permanently: parked
        // NPCs never tick their behavior, so they could never engage, so they
        // could never unpark — a troll 4 m behind the player stood frozen until
        // the camera happened to turn. distRing is what parking must read.
        expect(behind.lodState.distRing).toBe(0);
    });

    test('near off-frustum crowd keeps AI and avoidance ticks at its distance ring rate', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const behind = makeChar(0, -5, 'crowd'); // 5 m BEHIND camera -> distRing 0
        s.registerCharacter(behind);
        let aiTicks = 0;
        let avoidTicks = 0;
        for (let i = 0; i < 30; i++) {
            s.evaluate(cam, 1 / 60);
            if (behind.lodState.tickAi) aiTicks++;
            if (behind.lodState.tickAvoidance) avoidTicks++;
        }
        // distRing 0 = every-frame AI/avoidance (single char, caps never hit):
        // a zombie behind the car keeps chasing and stays hittable.
        expect(behind.lodState.simClass).toBe(SimClass.FULL);
        expect(aiTicks).toBe(30);
        expect(avoidTicks).toBe(30);
        expect(behind.lodState.tickAi).toBe(true);
    });

    test('heroes always get full simulation ticks at any distance', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const farHero = makeChar(0, 500, 'hero');
        run(s, [farHero], cam, 15);
        expect(farHero.lodState.tickAi).toBe(true);
        expect(farHero.lodState.tickAvoidance).toBe(true);
        expect(farHero.lodState.simClass).toBe(SimClass.FULL);
    });

    test('R2 crowd gets VIRTUAL sim class with goal, HIBERNATED without', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const farWithGoal = makeChar(0, 300, 'crowd');
        const farIdle = makeChar(5, 300, 'crowd');
        farIdle.hasActiveGoal = () => false;
        run(s, [farWithGoal, farIdle], cam, 15);
        expect(farWithGoal.lodState.simClass).toBe(SimClass.VIRTUAL);
        expect(farIdle.lodState.simClass).toBe(SimClass.HIBERNATED);
    });

    test('R1 crowd AI ticks at ~5 Hz, not every frame', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const mid = makeChar(0, 40, 'crowd');
        s.registerCharacter(mid);
        let aiTicks = 0;
        for (let i = 0; i < 60; i++) {
            s.evaluate(cam, 1 / 60);
            if (mid.lodState.tickAi) aiTicks++;
        }
        expect(aiTicks).toBeGreaterThanOrEqual(3);
        expect(aiTicks).toBeLessThanOrEqual(8);
    });

    test('same-frame-registered crowds de-phase: anim ticks spread across frames, no lockstep bursts', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        // 50 crowd NPCs all in R1 (anim 15 Hz), registered in one loop like a horde spawn.
        const chars = Array.from({ length: 50 }, (_, i) => makeChar((i % 10) * 2 - 9, 35 + Math.floor(i / 10) * 2, 'crowd'));
        for (const c of chars) s.registerCharacter(c);
        // Settle past the phase-spread window, then measure a 60-frame window.
        for (let i = 0; i < 30; i++) s.evaluate(cam, 1 / 60);
        const perFrame: number[] = [];
        for (let f = 0; f < 60; f++) {
            s.evaluate(cam, 1 / 60);
            perFrame.push(chars.filter((c) => c.lodState.tickAnim).length);
        }
        // 50 chars at 15 Hz over 60 fps = ~12.5 grants/frame if spread evenly.
        // Lockstep would put all 50 on the same frame every 4th frame.
        const worst = Math.max(...perFrame);
        expect(worst).toBeLessThanOrEqual(25);
        const total = perFrame.reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThan(600); // ~750 expected; rate preserved, not starved
    });

    test('global AI cap + round-robin fairness: every crowd NPC ticks within 3 s', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const chars = Array.from({ length: 300 }, (_, i) => makeChar((i % 20) * 3, 30 + Math.floor(i / 20) * 3, 'crowd'));
        for (const c of chars) s.registerCharacter(c);
        const ticked = new Set<number>();
        for (let f = 0; f < 180; f++) {
            s.evaluate(cam, 1 / 60);
            let thisFrame = 0;
            chars.forEach((c, i) => { if (c.lodState.tickAi) { ticked.add(i); thisFrame++; } });
            expect(thisFrame).toBeLessThanOrEqual(DEFAULT_CHARACTER_LOD.caps.aiPerFrame);
        }
        expect(ticked.size).toBe(300);
    });

    test('hysteresis: no ring flapping at the boundary', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const c = makeChar(0, DEFAULT_CHARACTER_LOD.r0DistanceM + 0.5, 'crowd'); // just past R0 edge
        run(s, [c], cam, 15);
        const ringA = c.lodState.ring;
        c.pos.z -= 1.0; // cross the nominal boundary inward, but inside hysteresis band
        run(s, [c], cam, 15);
        expect(c.lodState.ring).toBe(ringA); // held by hysteresis
        c.pos.z = 5; // decisively near
        run(s, [c], cam, 15);
        expect(c.lodState.ring).toBe(0);
    });

    test('disabled scheduler stamps FULL/all-ticks for everyone', () => {
        const s = new CharacterLodScheduler();
        s.setEnabled(false);
        const cam = makeCamera();
        const far = makeChar(0, 300, 'crowd');
        run(s, [far], cam, 1);
        expect(far.lodState.tickAi).toBe(true);
        expect(far.lodState.simClass).toBe(SimClass.FULL);
        expect(far.lodState.castShadow).toBe(true);
    });

    test('dead/ragdolled characters are exempt from demotion (stamped FULL)', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const corpse = makeChar(0, 300, 'crowd');
        corpse.isDeadOrRagdolled = () => true;
        run(s, [corpse], cam, 15);
        expect(corpse.lodState.simClass).toBe(SimClass.FULL);
    });

    test('dead character keeps a REAL ring that tracks distance (near corpse syncs, far freezes)', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const corpse = makeChar(0, 10, 'crowd'); // near, on frustum
        corpse.isDeadOrRagdolled = () => true;
        run(s, [corpse], cam, 15);
        expect(corpse.lodState.ring).toBe(0);
        expect(corpse.lodState.simClass).toBe(SimClass.FULL);
        // Corpse moves far away (or the camera leaves): ring must follow.
        corpse.pos.z = 300;
        run(s, [corpse], cam, 15);
        expect(corpse.lodState.ring).toBe(2);
        expect(corpse.lodState.simClass).toBe(SimClass.FULL);
        // Camera comes back near the corpse: sync resumes.
        corpse.pos.z = 10;
        run(s, [corpse], cam, 15);
        expect(corpse.lodState.ring).toBe(0);
    });

    test('castShadow follows the distance-only ring: near off-frustum char keeps its shadow', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const behind = makeChar(0, -5, 'crowd'); // 5 m BEHIND the camera
        run(s, [behind], cam, 15);
        expect(behind.lodState.ring).toBe(2);          // frustum-forced far ring
        expect(behind.lodState.castShadow).toBe(true); // but the shadow can still fall on-screen
    });

    test('playerPosition folds into the distance metric (zoomed-out camera)', () => {
        const s = new CharacterLodScheduler();
        // Camera 100 m overhead looking down at the origin.
        const cam = new THREE.PerspectiveCamera(75, 1.6, 0.1, 1000);
        cam.position.set(0, 100, 1);
        cam.lookAt(0, 0, 0);
        cam.updateMatrixWorld(true);
        cam.updateProjectionMatrix();
        const nearPlayer = makeChar(3, 0, 'crowd'); // 3 m from the player, ~100 m from the camera
        s.registerCharacter(nearPlayer);
        const playerPos = new THREE.Vector3(0, 0, 0);
        for (let i = 0; i < 15; i++) s.evaluate(cam, 1 / 60, playerPos);
        expect(nearPlayer.lodState.ring).toBe(0);
        // Without the player position the same character is far ring.
        const s2 = new CharacterLodScheduler();
        const other = makeChar(3, 0, 'crowd');
        s2.registerCharacter(other);
        for (let i = 0; i < 15; i++) s2.evaluate(cam, 1 / 60);
        expect(other.lodState.ring).toBe(2);
    });

    test('null camera stamps everyone FULL (pathfinding must not freeze)', () => {
        const s = new CharacterLodScheduler();
        const far = makeChar(0, 300, 'crowd');
        s.registerCharacter(far);
        s.evaluate(null, 1 / 60);
        expect(far.lodState.simClass).toBe(SimClass.FULL);
        expect(far.lodState.tickAi).toBe(true);
    });

    test('dumpStates lists every character with scheduler fields and controller detail', () => {
        const s = new CharacterLodScheduler();
        const cam = makeCamera();
        const near = makeChar(0, 10, 'crowd');
        near.getLodDebugInfo = () => 'id=zombie-1 vis=y';
        const far = makeChar(0, 300, 'hero');
        run(s, [near, far], cam, 15);
        const dump = s.dumpStates();
        expect(dump).toContain('2 chars');
        expect(dump).toContain('crowd');
        expect(dump).toContain('hero');
        expect(dump).toContain('distRing=0');
        expect(dump).toContain('sim=FULL');
        expect(dump).toContain('id=zombie-1 vis=y');
        expect(dump).toContain('d=10.2'); // camera sits at y=2, char at y=0 -> 3D distance
    });

    test('global accessor lazily creates and dispose resets', () => {
        const a = getGlobalLodScheduler();
        expect(getGlobalLodScheduler()).toBe(a);
        disposeGlobalLodScheduler();
        expect(getGlobalLodScheduler()).not.toBe(a);
    });
});
