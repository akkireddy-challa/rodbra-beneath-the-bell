/**
 * Local-first ghosts.
 *
 * The behaviour these pin was missing on the first attempt and read to a player
 * as "recording is broken": a finished lap was encoded, uploaded, and dropped,
 * so your own run could only come back via a server round trip. Waiting on the
 * network to show a player their OWN lap is wrong on a slow connection and
 * impossible offline, so the local copy is now authoritative and the upload is
 * enrichment.
 */

import * as THREE from 'three';
import { GhostRacing, DEFAULT_GHOST_RACING_OPTIONS } from 'engine/replay/GhostRacing.js';
import { LOCAL_ENTRY_ID, setLocalRunStore } from 'engine/replay/GhostLocalRuns.js';
import { fetchBoard, resetBoardFailures } from 'engine/replay/GhostBoard.js';
import { GamePersistence } from 'engine/persistence/GamePersistence.js';
import type { StorageAdapter } from 'engine/persistence/StorageAdapter.js';
import type { GameDataService } from 'engine/gamedata/GameDataService.js';
import { GhostIdentity, DEFAULT_GHOST_IDENTITY_OPTIONS } from 'engine/replay/GhostIdentity.js';
import { generatedNameFor } from 'engine/replay/GhostNames.js';
import type { EngineLike } from 'types/game.js';
import type { ReplayVehicleSubject } from 'engine/replay/ReplaySubjects.js';

function memoryAdapter(): StorageAdapter {
    const store = new Map<string, string>();
    return {
        isAvailable: () => true,
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
        hasItem: (key: string) => store.has(key),
        listKeys: (prefix?: string) => [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
    };
}

/** A vehicle driving a straight line, enough to record something decodable. */
function fakeVehicle(): ReplayVehicleSubject & { t: number } {
    return {
        t: 0,
        getPosition(): THREE.Vector3 { return new THREE.Vector3(0, 0, this.t * 20); },
        getChassisObject: (): THREE.Object3D => new THREE.Object3D(),
        getForwardSpeed: (): number => 20,
        getSteeringAngle: (): number => 0,
        getWheelCount: (): number => 4,
        getWheelRotation(): number { return this.t * 57; },
        getFootprint: () => ({ width: 1.8, height: 1.1, length: 4.2 }),
        getWheelConfigs: () => [
            { position: { x: -0.8, y: -0.2, z: 1.3 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: true },
            { position: { x: 0.8, y: -0.2, z: 1.3 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: true },
            { position: { x: -0.8, y: -0.2, z: -1.3 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: false },
            { position: { x: 0.8, y: -0.2, z: -1.3 }, radius: 0.35, width: 0.25, suspensionRestLength: 0.3, isSteering: false },
        ],
    };
}

/** A game data service that is DOWN — the localhost case, and any offline player. */
function offlineService(): GameDataService {
    const reject = (): Promise<never> => Promise.reject(new Error('network down'));
    return {
        list: reject, get: reject, create: reject, rank: reject,
        updateEntry: reject, delete: reject, configure: () => {}, invalidateSessionToken: () => {},
    } as unknown as GameDataService;
}

function guestIdentity(): GhostIdentity {
    return {
        resolve: async () => ({ playerId: 'g_test', verifier: 'v' }),
        isGuest: () => true,
    } as unknown as GhostIdentity;
}

function fakeEngine(assetNames: string[] = []): EngineLike {
    return {
        scene: new THREE.Scene(),
        getGameData: () => ({ assets: assetNames.map((name) => ({ id: name, name })) }),
    } as unknown as EngineLike;
}

async function driveALap(racing: GhostRacing, seconds: number, vehicle: { t: number }): Promise<void> {
    racing.startRun();
    for (let i = 0; i < seconds * 60; i++) {
        vehicle.t += 1 / 60;
        racing.updateGhosts(1 / 60);
    }
}

describe('GhostRacing local-first ghosts', () => {
    let persistence: GamePersistence;
    let engine: EngineLike;
    let vehicle: ReturnType<typeof fakeVehicle>;
    let racing: GhostRacing;

    beforeEach(() => {
        persistence = new GamePersistence(memoryAdapter(), 'TESTGAME1234', 1);
        // Matches how GameEngine builds the ghost store: notifications off,
        // because a "Progress saved" toast after every lap is not a save the
        // player asked for. (It also constructs DOM, which node has none of.)
        persistence.setNotification({ enabled: false });
        // GameEngine installs this for real; board reads are free functions so
        // the store is module-wide (see GhostLocalRuns).
        setLocalRunStore(persistence);
        engine = fakeEngine();
        vehicle = fakeVehicle();
        racing = new GhostRacing(engine, offlineService(), persistence, guestIdentity(), 'TESTGAME1234');
    });

    afterEach(() => {
        racing.detach();
        setLocalRunStore(null);
    });

    async function attach(): Promise<void> {
        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
        });
    }

    test('a finished lap becomes a ghost with the network completely down', async () => {
        await attach();
        await driveALap(racing, 2, vehicle);
        const result = await racing.finishRun({ timeMs: 65_800 });

        // The upload failed — that is the point of this test.
        expect(result.submitted).toBe(false);
        expect(result.isPersonalBest).toBe(true);

        // ...and the ghost is still there for the next run.
        racing.startRun();
        const ghosts = racing.getActiveGhosts();
        expect(ghosts).toHaveLength(1);
        expect(ghosts[0]?.isLocal).toBe(true);
        expect(ghosts[0]?.timeMs).toBe(65_800);
    });

    test('"race again" picks up the lap just driven, with no re-attach', async () => {
        // The original bug: ghosts were only built during attach(), so a new
        // personal best did not appear until the level was reloaded.
        await attach();
        expect(racing.getActiveGhosts()).toHaveLength(0);

        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        racing.startRun();
        expect(racing.getActiveGhosts()).toHaveLength(1);
    });

    test('the ghost survives a level reload, because the run is on the device', async () => {
        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        // A fresh facade over the SAME persistence — a page reload or a trip
        // through track selection.
        const reloaded = new GhostRacing(
            fakeEngine(), offlineService(), persistence, guestIdentity(), 'TESTGAME1234',
        );
        await reloaded.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
        });

        const ghosts = reloaded.getActiveGhosts();
        expect(ghosts).toHaveLength(1);
        expect(ghosts[0]?.entryId).toBe(LOCAL_ENTRY_ID);
        reloaded.detach();
    });

    test('beating your own time replaces the ghost rather than stacking a crowd', async () => {
        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });
        racing.startRun();
        expect(racing.getActiveGhosts()).toHaveLength(1);

        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 60_100 });
        racing.startRun();

        const ghosts = racing.getActiveGhosts();
        expect(ghosts).toHaveLength(1);
        expect(ghosts[0]?.timeMs).toBe(60_100);
    });

    test('a slower lap leaves the better ghost in place', async () => {
        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 60_000 });

        await driveALap(racing, 2, vehicle);
        const worse = await racing.finishRun({ timeMs: 70_000 });
        expect(worse.isPersonalBest).toBe(false);

        racing.startRun();
        expect(racing.getActiveGhosts()[0]?.timeMs).toBe(60_000);
    });

    test('a ghost is scoped to its level', async () => {
        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'a-different-track',
        });
        expect(racing.getActiveGhosts()).toHaveLength(0);
    });

    test('a run remembers the vehicle it was set with', async () => {
        // Which car set a time is part of the record — replaying it in the
        // wrong kart misrepresents it.
        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
            assetId: 'turbo-kart',
        });
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        const stored = persistence.load<Record<string, Array<{ assetId: string | null }>>>('ghost-local-runs').data;
        expect(stored?.['hollow-ridge']?.[0]?.assetId).toBe('turbo-kart');
    });

    test('a ghost set in another kart is drawn as that kart', async () => {
        engine = fakeEngine(['turbo-kart', 'rust-bucket']);
        racing = new GhostRacing(engine, offlineService(), persistence, guestIdentity(), 'TESTGAME1234');

        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
            assetId: 'rust-bucket',
        });
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        // Re-attach driving something else: the ghost keeps the kart it used.
        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
            assetId: 'turbo-kart',
        });
        expect(racing.getActiveGhosts()).toHaveLength(1);
    });

    test('a ghost whose kart the game no longer ships falls back, loudly', async () => {
        // A creator can delete or rename a kart at any time. An old record must
        // not disappear over it.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        engine = fakeEngine(['turbo-kart']);
        racing = new GhostRacing(engine, offlineService(), persistence, guestIdentity(), 'TESTGAME1234');

        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
            assetId: 'kart-that-gets-deleted',
        });
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
            assetId: 'turbo-kart',
        });

        expect(racing.getActiveGhosts()).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('no longer has'));
        warn.mockRestore();
    });

    test('the board shows your own record when the remote board is unreachable', async () => {
        // A player who has driven the track HAS a time. Reporting "no times
        // recorded" because a request failed is wrong on screen, not just in
        // the log.
        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        const board = racing.getBoard();
        expect(board).toHaveLength(1);
        expect(board[0]?.timeMs).toBe(65_800);
        expect(board[0]?.entryId).toBe(LOCAL_ENTRY_ID);
    });

    test('the board is empty before any lap is driven', async () => {
        await attach();
        expect(racing.getBoard()).toHaveLength(0);
    });

    test('the ghost body is a CLONE of the live car, not a rebuilt box', async () => {
        // Reconstructing a body from a descriptor is guesswork; the live car is
        // exact. The clone must also not share the original's world position.
        const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4));
        body.name = 'RealKartBody';
        const chassis = new THREE.Group();
        chassis.add(body);
        chassis.position.set(120, 3, 400); // live cars sit in world space
        vehicle.getChassisObject = () => chassis;

        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        let found: THREE.Object3D | null = null;
        for (const ghost of engine.scene?.children ?? []) {
            ghost.traverse((child) => { if (child.name === 'RealKartBody') found = child; });
        }
        expect(found).not.toBeNull();
        // The clone is its own object, and the ghost's root supplies position.
        expect(found).not.toBe(body);
        expect(chassis.position.x).toBe(120);
    });

    test('clones a chassis whose userData holds circular physics refs', async () => {
        // The live vehicle carries Rapier handles in userData, and colliderSet
        // closes a reference cycle. Object3D.clone() deep-copies userData via
        // JSON.stringify and throws "Converting circular structure to JSON",
        // which spawnGhost swallowed — so the ghost silently never appeared.
        const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4));
        body.name = 'RealKartBody';
        const chassis = new THREE.Group();
        chassis.add(body);

        const circular: Record<string, unknown> = { colliderSet: {} };
        (circular.colliderSet as Record<string, unknown>).parent = circular;
        chassis.userData = circular;
        body.userData = circular;
        vehicle.getChassisObject = () => chassis;

        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });

        let found: THREE.Object3D | null = null;
        for (const ghost of engine.scene?.children ?? []) {
            ghost.traverse((child) => { if (child.name === 'RealKartBody') found = child; });
        }
        expect(found).not.toBeNull();
        // The physics references must not travel with the ghost.
        expect((found as unknown as THREE.Object3D).userData.colliderSet).toBeUndefined();
        expect(racing.getActiveGhosts()).toHaveLength(1);
    });

    test('disposing a ghost does not free geometry shared with the live car', async () => {
        // Object3D.clone() SHARES geometry. Disposing it would blank the
        // player's own vehicle mid-race.
        const geometry = new THREE.BoxGeometry(2, 1, 4);
        const body = new THREE.Mesh(geometry);
        const chassis = new THREE.Group();
        chassis.add(body);
        vehicle.getChassisObject = () => chassis;

        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });
        racing.detach();

        // Still usable: a disposed BufferGeometry drops its attributes.
        expect(geometry.getAttribute('position')).toBeDefined();
    });

    test('loads a run stored by a PRE-multi-run build', async () => {
        // Player-device data outlives any single build. When a level went from
        // holding one run to holding a list, the reader met an object where it
        // expected an array and threw `runs.slice is not a function` — taking
        // the whole ghost load down with it.
        const legacy = { encodedRun: '', timeMs: 0, savedAt: 0, assetId: null };
        // Produce a genuinely decodable payload, then store it the OLD way.
        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });
        const current = persistence.load<Record<string, Array<typeof legacy>>>('ghost-local-runs').data;
        const run = current?.['hollow-ridge']?.[0];
        if (!run) throw new Error('expected a stored run');
        persistence.save({ 'hollow-ridge': run }, 'ghost-local-runs'); // single object, not a list

        const reloaded = new GhostRacing(
            fakeEngine(), offlineService(), persistence, guestIdentity(), 'TESTGAME1234',
        );
        await reloaded.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
        });

        expect(reloaded.getActiveGhosts()).toHaveLength(1);
        expect(reloaded.getBoard()[0]?.timeMs).toBe(65_800);
        reloaded.detach();
    });

    test('corrupt storage is skipped, not thrown over', async () => {
        persistence.save(
            {
                'hollow-ridge': { nonsense: true },
                'other': [{ encodedRun: '', timeMs: 1 }, null, 'garbage'],
            },
            'ghost-local-runs',
        );
        await expect(attach()).resolves.toBeUndefined();
        expect(racing.getActiveGhosts()).toHaveLength(0);
        expect(racing.getBoard()).toHaveLength(0);
    });

    test('detach releases the ghost meshes', async () => {
        await attach();
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 65_800 });
        racing.startRun();

        const scene = engine.scene;
        expect(scene?.children.length).toBeGreaterThan(0);
        racing.detach();
        expect(scene?.children).toHaveLength(0);
    });

    test('local runs are bounded so many tracks cannot fill storage', async () => {
        for (let i = 0; i < 12; i++) {
            await racing.attach({
                ...DEFAULT_GHOST_RACING_OPTIONS,
                subject: () => vehicle,
                input: null,
                levelId: `track-${i}`,
            });
            await driveALap(racing, 1, vehicle);
            await racing.finishRun({ timeMs: 60_000 + i, name: null });
        }
        const stored = persistence.load<Record<string, unknown[]>>('ghost-local-runs').data ?? {};
        expect(Object.keys(stored).length).toBeLessThanOrEqual(8);
        // The most recent survive; the oldest are evicted.
        expect(Object.keys(stored)).toContain('track-11');
        expect(Object.keys(stored)).not.toContain('track-0');
    });

    test('a lap on a device with no Compression Streams API still becomes a ghost', async () => {
        // iOS WebKit below 16.4. The codec falls back to bundled fflate, so
        // this is an ordinary lap — it used to be a thrown ReferenceError.
        const globals = globalThis as Record<string, unknown>;
        const saved = [globals.CompressionStream, globals.DecompressionStream];
        delete globals.CompressionStream;
        delete globals.DecompressionStream;
        try {
            await attach();
            await driveALap(racing, 2, vehicle);
            const result = await racing.finishRun({ timeMs: 65_800 });
            expect(result.isPersonalBest).toBe(true);

            racing.startRun();
            expect(racing.getActiveGhosts()).toHaveLength(1);
        } finally {
            [globals.CompressionStream, globals.DecompressionStream] = saved;
        }
    });

    test('an encoder that fails ends the race instead of throwing at the caller', async () => {
        // finishRun() is called from a game's finish-line handler. An exception
        // there takes the results screen down over a failure that should only
        // cost the player a ghost. Simulated by removing base64, which stands in
        // for any runtime the encoder cannot work in.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
        const globals = globalThis as Record<string, unknown>;
        const savedBtoa = globals.btoa;
        delete globals.btoa;
        try {
            await attach();
            await driveALap(racing, 2, vehicle);
            const result = await racing.finishRun({ timeMs: 65_800 });

            expect(result.submitted).toBe(false);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('encoding the run failed'),
                expect.anything(),
            );
        } finally {
            globals.btoa = savedBtoa;
            warn.mockRestore();
        }
    });
});


/**
 * `?ghosts=all` — the testing affordance for a single-player machine.
 *
 * Production keeps one run per player: uploads are gated on a personal best and
 * the board dedupes by player. Both are right for a real board and both make it
 * impossible to see a FIELD of ghosts without a second human, which is exactly
 * what needs testing.
 */
describe('GhostRacing multi-run mode', () => {
    let persistence: GamePersistence;
    let engine: EngineLike;
    let vehicle: ReturnType<typeof fakeVehicle>;
    let racing: GhostRacing;

    beforeEach(() => {
        (globalThis as { window?: unknown }).window = { location: { search: '?ghosts=all' } };
        persistence = new GamePersistence(memoryAdapter(), 'TESTGAME1234', 1);
        persistence.setNotification({ enabled: false });
        // GameEngine installs this for real; board reads are free functions so
        // the store is module-wide (see GhostLocalRuns).
        setLocalRunStore(persistence);
        engine = fakeEngine();
        vehicle = fakeVehicle();
        racing = new GhostRacing(engine, offlineService(), persistence, guestIdentity(), 'TESTGAME1234');
    });
    afterEach(() => {
        racing.detach();
        setLocalRunStore(null);
        delete (globalThis as { window?: unknown }).window;
    });

    async function attachMulti(opponents = 4): Promise<void> {
        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'hollow-ridge',
            opponents,
        });
    }

    async function lap(timeMs: number): Promise<void> {
        await driveALap(racing, 1, vehicle);
        await racing.finishRun({ timeMs });
    }

    test('keeps every run, including ones slower than your best', async () => {
        await attachMulti();
        await lap(60_000);
        await lap(70_000); // slower — normally discarded
        await lap(65_000);

        const board = racing.getBoard();
        expect(board).toHaveLength(3);
        expect(board.map((row) => row.timeMs)).toEqual([60_000, 65_000, 70_000]);
    });

    test('races a FIELD of ghosts rather than one', async () => {
        await attachMulti();
        await lap(60_000);
        await lap(65_000);
        await lap(70_000);

        const ghosts = racing.getActiveGhosts();
        expect(ghosts).toHaveLength(3);
        expect(ghosts.every((ghost) => ghost.isLocal)).toBe(true);
        // Distinct ids, so a UI can list them separately.
        expect(new Set(ghosts.map((ghost) => ghost.entryId)).size).toBe(3);
    });

    test('never fields more ghosts than the game asked for', async () => {
        await attachMulti(2);
        await lap(60_000);
        await lap(61_000);
        await lap(62_000);
        expect(racing.getActiveGhosts()).toHaveLength(2);
    });

    test('retains only the fastest few, so storage stays bounded', async () => {
        await attachMulti();
        for (let i = 0; i < 9; i++) await lap(60_000 + i * 1000);

        const stored = persistence.load<Record<string, unknown[]>>('ghost-local-runs').data ?? {};
        expect(stored['hollow-ridge']?.length).toBe(5);
        expect(racing.getBoard()[0]?.timeMs).toBe(60_000);
    });

    test('is off by default — one run per player is the real behaviour', async () => {
        delete (globalThis as { window?: unknown }).window;
        const solo = new GhostRacing(
            fakeEngine(), offlineService(), persistence, guestIdentity(), 'TESTGAME1234',
        );
        await solo.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'other-track',
        });
        await driveALap(solo, 1, vehicle);
        await solo.finishRun({ timeMs: 60_000 });
        await driveALap(solo, 1, vehicle);
        await solo.finishRun({ timeMs: 70_000 });

        expect(solo.getBoard()).toHaveLength(1);
        expect(solo.getBoard()[0]?.timeMs).toBe(60_000);
        solo.detach();
    });
});


/**
 * The path the LEVEL SELECTOR uses.
 *
 * `fetchBoard()` is a free function game code calls directly — not through the
 * facade — so it is the one that must show a player their own records. It
 * failing to do that is what made a driven track report "no times recorded".
 */
describe('fetchBoard is local-first', () => {
    let persistence: GamePersistence;
    let engine: EngineLike;
    let vehicle: ReturnType<typeof fakeVehicle>;
    let racing: GhostRacing;

    beforeEach(() => {
        resetBoardFailures();
        persistence = new GamePersistence(memoryAdapter(), 'TESTGAME1234', 1);
        persistence.setNotification({ enabled: false });
        setLocalRunStore(persistence);
        engine = fakeEngine();
        vehicle = fakeVehicle();
        racing = new GhostRacing(engine, offlineService(), persistence, guestIdentity(), 'TESTGAME1234');
    });
    afterEach(() => {
        racing.detach();
        setLocalRunStore(null);
        resetBoardFailures();
    });

    test('returns the run you just drove, with the service completely down', async () => {
        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'dust-devil-ridge',
        });
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 74_700 });

        // Exactly what the level selector calls.
        const board = await fetchBoard(offlineService(), 'dust-devil-ridge', 50);
        expect(board).toHaveLength(1);
        expect(board[0]?.timeMs).toBe(74_700);
    });

    test('never throws when the service is down', async () => {
        await expect(fetchBoard(offlineService(), 'never-driven', 50)).resolves.toEqual([]);
    });

    test('merges remote rows with local ones, best first', async () => {
        const service = {
            list: async () => ({
                entries: [{
                    id: 'server-1',
                    values: { timeMs: 70_000, name: 'Rival' },
                    meta: { revision: 1, createdAt: 'x', updatedAt: 'x', expireAt: null },
                    createdByUid: 'pub_rival',
                }],
                nextCursor: null,
            }),
        } as unknown as GameDataService;

        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'merge-track',
        });
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 74_700 });

        const board = await fetchBoard(service, 'merge-track', 50);
        expect(board.map((row) => row.timeMs)).toEqual([70_000, 74_700]);
    });

    test('does not list the same lap twice once it has uploaded', async () => {
        const service = {
            list: async () => ({
                entries: [{
                    id: 'server-1',
                    values: { timeMs: 74_700, name: 'You' },
                    meta: { revision: 1, createdAt: 'x', updatedAt: 'x', expireAt: null },
                    createdByUid: 'pub_me',
                }],
                nextCursor: null,
            }),
        } as unknown as GameDataService;

        await racing.attach({
            ...DEFAULT_GHOST_RACING_OPTIONS,
            subject: () => vehicle,
            input: null,
            levelId: 'dupe-track',
        });
        await driveALap(racing, 2, vehicle);
        await racing.finishRun({ timeMs: 74_700 });

        const board = await fetchBoard(service, 'dupe-track', 50);
        expect(board).toHaveLength(1);
    });
});

/**
 * Display names.
 *
 * A game must never prompt for one: a signed-in player already chose a name on
 * their profile, and a guest has a generated one. Asking would create a second
 * identity that conflicts with the account, and would throw away the guest name
 * whose loss is the reason to sign in at all.
 */
describe('GhostIdentity display names', () => {
    function identityFor(playerId: string): GhostIdentity {
        const persistence = new GamePersistence(memoryAdapter(), 'TESTGAME1234', 1);
        persistence.setNotification({ enabled: false });
        persistence.save({ playerId, verifier: 'v', linkedFrom: null }, 'ghost-identity');
        return new GhostIdentity(
            { ...DEFAULT_GHOST_IDENTITY_OPTIONS, gameId: 'TESTGAME1234' },
            persistence,
            async () => null,
        );
    }

    test('a guest gets a generated name, with no network call', async () => {
        const fetchSpy = jest.spyOn(globalThis, 'fetch');
        const name = await identityFor('g_0123456789abcdef0123456789abcdef').displayName();

        expect(name).toBe(generatedNameFor('g_0123456789abcdef0123456789abcdef'));
        expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/);
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    test('an account falls back to a generated name when the profile is unreachable', async () => {
        // A finished run must never wait on, or be lost to, a profile lookup.
        const fetchSpy = jest.spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('offline'));
        const name = await identityFor('pub_alice').displayName();

        expect(name).toBe(generatedNameFor('pub_alice'));
        fetchSpy.mockRestore();
    });

    test('an account uses its profile name, fetched once and cached', async () => {
        const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            json: async () => ({ refs: [{ displayName: 'Jani' }] }),
        } as Response);

        const identity = identityFor('pub_alice');
        expect(await identity.displayName()).toBe('Jani');
        expect(await identity.displayName()).toBe('Jani');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        fetchSpy.mockRestore();
    });
});
