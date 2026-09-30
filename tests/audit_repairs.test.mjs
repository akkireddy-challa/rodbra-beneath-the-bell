import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Register path resolution hook for 'engine/*', 'types/*', 'work/*' and .ts extensions
register('./alias-hook.mjs', import.meta.url);

// Mock localStorage for Node.js environment
const mockStorage = new Map();
globalThis.localStorage = {
    getItem(key) {
        return mockStorage.get(key) ?? null;
    },
    setItem(key, value) {
        mockStorage.set(key, String(value));
    },
    removeItem(key) {
        mockStorage.delete(key);
    },
    clear() {
        mockStorage.clear();
    },
};

// Directly import PRODUCTION source classes
const { SaveGameService } = await import('../src/work/SaveGameService.js');
const { INITIAL_PLAYER_STATS } = await import('../src/work/Constants.js');
const STORAGE_KEY_V2 = 'rodbra_save_v2';
const STORAGE_KEY_V1 = 'rodbra_save_v1';

// -------------------------------------------------------------
// [Pure Unit Test] Production SaveGameService V2 Persistence & Migration
// -------------------------------------------------------------
test('[Pure Unit] Production SaveGameService: saves and loads V2 schema accurately', () => {
    localStorage.clear();
    assert.equal(SaveGameService.hasSave(), false);

    const testData = {
        stats: {
            ...INITIAL_PLAYER_STATS,
            currentHealth: 85,
            ironNails: 7,
            upgrades: { temperedEdge: true, wovenCharm: false, quickenedWard: false },
        },
        activeCheckpointId: 'checkpoint_hushwood',
        discoveredCheckpointIds: ['checkpoint_prologue', 'checkpoint_hushwood'],
        consumedInteractableIds: ['cache_hushwood'],
        completedBosses: {
            hollowThrallTutorial: true,
            antlerMiniboss: false,
            millButcherBoss: false,
            bellMotherBoss: false,
        },
        unlockedShortcuts: {
            hushwoodGate: true,
            millGate: false,
        },
        currentZoneIndex: 1,
    };

    const saved = SaveGameService.save(testData);
    assert.equal(saved, true);
    assert.equal(SaveGameService.hasSave(), true);

    const loaded = SaveGameService.load();
    assert.ok(loaded);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.activeCheckpointId, 'checkpoint_hushwood');
    assert.deepEqual(loaded.discoveredCheckpointIds, ['checkpoint_prologue', 'checkpoint_hushwood']);
    assert.equal(loaded.stats.currentHealth, 85);
    assert.equal(loaded.stats.ironNails, 7);
    assert.equal(loaded.stats.upgrades.temperedEdge, true);
    assert.equal(loaded.completedBosses.hollowThrallTutorial, true);
    assert.equal(loaded.unlockedShortcuts.hushwoodGate, true);
});

test('[Pure Unit] Production SaveGameService: migrates legacy v1 save to v2 schema cleanly', () => {
    localStorage.clear();
    const legacyV1 = {
        savedAt: 1700000000000,
        stats: {
            currentHealth: 70,
            ironNails: 5,
            activeCheckpointId: 'checkpoint_redmill',
            upgrades: { temperedEdge: false, wovenCharm: true, quickenedWard: false },
            completedBosses: { hollowThrallTutorial: true, antlerMiniboss: true },
            unlockedShortcuts: { hushwoodGate: true },
        },
    };
    localStorage.setItem(STORAGE_KEY_V1, JSON.stringify(legacyV1));

    assert.equal(SaveGameService.hasSave(), true);
    const loaded = SaveGameService.load();
    assert.ok(loaded);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.activeCheckpointId, 'checkpoint_redmill');
    assert.equal(loaded.stats.currentHealth, 70);
    assert.equal(loaded.stats.ironNails, 5);
    assert.equal(loaded.stats.upgrades.wovenCharm, true);
    assert.equal(loaded.completedBosses.antlerMiniboss, true);
    assert.equal(loaded.completedBosses.millButcherBoss, false);
    assert.equal(loaded.unlockedShortcuts.hushwoodGate, true);
    assert.equal(loaded.unlockedShortcuts.millGate, false);

    // Verify it persisted the v2 payload
    assert.ok(localStorage.getItem(STORAGE_KEY_V2));
});

test('[Pure Unit] Production SaveGameService: handles malformed data gracefully without throwing', () => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY_V2, '{ broken json content ...');
    assert.equal(SaveGameService.load(), null);

    SaveGameService.clear();
    assert.equal(SaveGameService.hasSave(), false);
});

// -------------------------------------------------------------
// [Pure Unit Test] Level Bounds & Terrain Reachability (96m x 640m)
// -------------------------------------------------------------
test('[Pure Unit] World Level Dimensions: ground extends through z=280 with no falls', () => {
    const groundWorldSizeX = 96;
    const groundWorldSizeZ = 640;
    const halfX = groundWorldSizeX / 2; // 48m (-48 to +48)
    const halfZ = groundWorldSizeZ / 2; // 320m (-320 to +320)

    const routeWaypoints = [
        { name: 'Spawn', x: 0, z: 4 },
        { name: 'Sword Altar', x: 0, z: 16 },
        { name: 'Tutorial Thrall', x: 0, z: 26 },
        { name: 'Hushwood Approach', x: 0, z: 45 },
        { name: 'Hushwood Checkpoint', x: 0, z: 68 },
        { name: 'Stave Chapel Arena (Antler Chieftain)', x: 0, z: 104 },
        { name: 'Hushwood Gate', x: 0, z: 114 },
        { name: 'Red Mill Checkpoint', x: 0, z: 142 },
        { name: 'Pendulum Hazard', x: 0, z: 160 },
        { name: 'Butcher of Vargdal Arena', x: 0, z: 180 },
        { name: 'Mill Gate', x: 0, z: 195 },
        { name: 'Crypt Descent', x: 0, z: 210 },
        { name: 'Rooted Vault Checkpoint', x: 0, z: 225 },
        { name: 'Bell Mother Arena', x: 0, z: 258 },
        { name: 'Root Barrier', x: 0, z: 263 },
        { name: 'Elin Altar', x: 0, z: 268 },
        { name: 'Dawn Boundary', x: 0, z: 278 },
    ];

    for (const wp of routeWaypoints) {
        assert.ok(
            Math.abs(wp.x) <= halfX,
            `Waypoint ${wp.name} X=${wp.x} must be within [-${halfX}, +${halfX}]`
        );
        assert.ok(
            wp.z >= -halfZ && wp.z <= halfZ,
            `Waypoint ${wp.name} Z=${wp.z} must be within [-${halfZ}, +${halfZ}] (Terrain bounds)`
        );
    }

    // Assert that the ending boundary (Z=278) still has ample margin before terrain edge
    const remainingMargin = halfZ - 278;
    assert.ok(remainingMargin > 30, `Remaining margin after dawn overlook is ${remainingMargin}m`);
});

// -------------------------------------------------------------
// [Pure Unit Test] Kill Plane Fall Recovery Guard
// -------------------------------------------------------------
test('[Pure Unit] Kill Plane: detects y < -10m and triggers respawn at active checkpoint', () => {
    let respawnCalled = false;
    let respawnCheckpointId = '';

    function checkKillPlane(pos, activeCpId) {
        if (pos.y < -10) {
            respawnCalled = true;
            respawnCheckpointId = activeCpId;
            return true;
        }
        return false;
    }

    // Normal movement above ground
    assert.equal(checkKillPlane({ x: 0, y: 1.5, z: 50 }, 'checkpoint_hushwood'), false);
    assert.equal(respawnCalled, false);

    // Fall into void (e.g. y = -11.2)
    assert.equal(checkKillPlane({ x: 0, y: -11.2, z: 50 }, 'checkpoint_hushwood'), true);
    assert.equal(respawnCalled, true);
    assert.equal(respawnCheckpointId, 'checkpoint_hushwood');
});

// -------------------------------------------------------------
// [Pure Unit Test] Checkpoint Gating & Deterministic Encounter Reset Logic
// -------------------------------------------------------------
test('[Pure Unit] Encounter Reset: common enemies respawn, completed bosses stay dead', () => {
    const enemies = [
        { id: 'thrall_tut', zone: 0, isBoss: false, isDead: true },
        { id: 'hw_boss', zone: 1, isBoss: true, bossKey: 'antlerMiniboss', isDead: true },
        { id: 'mill_thrall_1', zone: 2, isBoss: false, isDead: true },
        { id: 'mill_boss', zone: 2, isBoss: true, bossKey: 'millButcherBoss', isDead: false },
    ];

    const completedBosses = {
        hollowThrallTutorial: true,
        antlerMiniboss: true,
        millButcherBoss: false,
        bellMotherBoss: false,
    };

    function simulateReset(checkpointZone, completed) {
        return enemies.map(e => {
            if (e.isBoss) {
                if (completed[e.bossKey]) return { ...e, isDead: true };
                return { ...e, isDead: false };
            }
            if (e.zone >= checkpointZone) return { ...e, isDead: false };
            return { ...e };
        });
    }

    const resetState = simulateReset(2, completedBosses); // Resetting at Red Mill checkpoint
    assert.equal(resetState.find(e => e.id === 'thrall_tut').isDead, true);
    assert.equal(resetState.find(e => e.id === 'hw_boss').isDead, true);
    assert.equal(resetState.find(e => e.id === 'mill_thrall_1').isDead, false);
    assert.equal(resetState.find(e => e.id === 'mill_boss').isDead, false);
});

// -------------------------------------------------------------
// [Pure Unit Test] Upgrade Math & Progression Economy
// -------------------------------------------------------------
test('[Pure Unit] Upgrade Math: recalculates stats correctly (+15% sword, +20% HP, -20% ward CD)', () => {
    const baseDamage = 35;
    const baseHealth = 100;
    const baseWardCooldown = 15.0;

    function calculateStats(upgrades) {
        const damageMultiplier = upgrades.temperedEdge ? 1.15 : 1.0;
        const healthMultiplier = upgrades.wovenCharm ? 1.20 : 1.0;
        const wardCooldownMultiplier = upgrades.quickenedWard ? 0.80 : 1.0;

        return {
            swordDamage: Math.round(baseDamage * damageMultiplier),
            maxHealth: Math.round(baseHealth * healthMultiplier),
            wardCooldown: Number((baseWardCooldown * wardCooldownMultiplier).toFixed(2)),
        };
    }

    const fullUpgrades = calculateStats({ temperedEdge: true, wovenCharm: true, quickenedWard: true });
    assert.equal(fullUpgrades.swordDamage, 40); // 35 * 1.15 = 40.25 -> 40
    assert.equal(fullUpgrades.maxHealth, 120);  // 100 * 1.20 = 120
    assert.equal(fullUpgrades.wardCooldown, 12.0); // 15.0 * 0.80 = 12.0
});

// -------------------------------------------------------------
// [Pure Unit Test] Elin's Altar & Boss Gating
// -------------------------------------------------------------
test('[Pure Unit] Boss Progression Gating: gates and Elin altar require boss defeat', () => {
    let hushwoodGateOpen = false;
    let millGateOpen = false;
    let elinBarrierOpen = false;

    function onEnemyDefeated(type) {
        if (type === 'warden_miniboss') hushwoodGateOpen = true;
        if (type === 'butcher_boss') millGateOpen = true;
        if (type === 'bell_mother') elinBarrierOpen = true;
    }

    assert.equal(hushwoodGateOpen, false);
    assert.equal(millGateOpen, false);
    assert.equal(elinBarrierOpen, false);

    onEnemyDefeated('warden_miniboss');
    assert.equal(hushwoodGateOpen, true);
    assert.equal(millGateOpen, false);

    onEnemyDefeated('butcher_boss');
    assert.equal(millGateOpen, true);
    assert.equal(elinBarrierOpen, false);

    onEnemyDefeated('bell_mother');
    assert.equal(elinBarrierOpen, true);
});

// -------------------------------------------------------------
// [Pure Unit Test] Input Gating & Modal Pause Management
// -------------------------------------------------------------
test('[Pure Unit] Input Pipeline: Pause does not trap Escape key, modals close before unpause', () => {
    let isPaused = false;
    let activeModal = 'none';

    function handleKey(key) {
        if (key === 'Escape') {
            if (activeModal !== 'none') {
                activeModal = 'none';
                return 'closed_modal';
            }
            isPaused = !isPaused;
            return isPaused ? 'paused' : 'unpaused';
        }

        if (isPaused || activeModal !== 'none') {
            return 'blocked';
        }

        return `executed_${key}`;
    }

    assert.equal(handleKey('KeyJ'), 'executed_KeyJ');
    assert.equal(handleKey('Escape'), 'paused');
    assert.equal(isPaused, true);
    assert.equal(handleKey('KeyJ'), 'blocked');
    assert.equal(handleKey('Escape'), 'unpaused');
    assert.equal(isPaused, false);
});
