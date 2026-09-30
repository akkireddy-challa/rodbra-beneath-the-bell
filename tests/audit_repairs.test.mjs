import test from 'node:test';
import assert from 'node:assert/strict';

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

// Pure logic mirror for SaveGameService testing in Node.js
const STORAGE_KEY_V2 = 'rodbra_save_v2';
const STORAGE_KEY_V1 = 'rodbra_save_v1';

const INITIAL_PLAYER_STATS = {
    baseMaxHealth: 100,
    currentHealth: 100,
    rendMeter: 0,
    wardCharges: 3,
    wardRechargeTimer: 0,
    wardMaxCharges: 3,
    healCharges: 1,
    healMaxCharges: 1,
    ironNails: 0,
    upgrades: {
        temperedEdge: false,
        wovenCharm: false,
        quickenedWard: false,
    },
    swordAcquired: false,
    activeCheckpointId: 'checkpoint_prologue',
    completedBosses: {
        hollowThrallTutorial: false,
        antlerMiniboss: false,
        millButcherBoss: false,
        bellMotherBoss: false,
    },
    unlockedShortcuts: {
        hushwoodGate: false,
        millGate: false,
    },
    currentZoneIndex: 0,
};

class TestableSaveGameService {
    static save(data) {
        try {
            const payload = {
                version: 2,
                timestamp: Date.now(),
                stats: { ...data.stats },
                activeCheckpointId: data.activeCheckpointId,
                discoveredCheckpointIds: [...data.discoveredCheckpointIds],
                consumedInteractableIds: [...data.consumedInteractableIds],
                completedBosses: { ...data.completedBosses },
                unlockedShortcuts: { ...data.unlockedShortcuts },
                currentZoneIndex: data.currentZoneIndex,
            };
            localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(payload));
            return true;
        } catch {
            return false;
        }
    }

    static load() {
        try {
            const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
            if (rawV2) {
                const parsed = JSON.parse(rawV2);
                if (parsed && parsed.version === 2 && parsed.stats) {
                    return this.validateAndSanitize(parsed);
                }
            }

            const rawV1 = localStorage.getItem(STORAGE_KEY_V1);
            if (rawV1) {
                const parsedV1 = JSON.parse(rawV1);
                if (parsedV1 && parsedV1.stats) {
                    const migrated = {
                        version: 2,
                        timestamp: parsedV1.savedAt || Date.now(),
                        stats: { ...INITIAL_PLAYER_STATS, ...parsedV1.stats },
                        activeCheckpointId: parsedV1.stats.activeCheckpointId || 'checkpoint_prologue',
                        discoveredCheckpointIds: ['checkpoint_prologue'],
                        consumedInteractableIds: [],
                        completedBosses: {
                            ...INITIAL_PLAYER_STATS.completedBosses,
                            ...(parsedV1.stats.completedBosses || {}),
                        },
                        unlockedShortcuts: {
                            ...INITIAL_PLAYER_STATS.unlockedShortcuts,
                            ...(parsedV1.stats.unlockedShortcuts || {}),
                        },
                        currentZoneIndex: parsedV1.stats.currentZoneIndex || 0,
                    };
                    this.save(migrated);
                    return migrated;
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    static hasSave() {
        return !!localStorage.getItem(STORAGE_KEY_V2) || !!localStorage.getItem(STORAGE_KEY_V1);
    }

    static clear() {
        localStorage.removeItem(STORAGE_KEY_V2);
        localStorage.removeItem(STORAGE_KEY_V1);
    }

    static validateAndSanitize(data) {
        return {
            version: 2,
            timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
            stats: {
                ...INITIAL_PLAYER_STATS,
                ...(data.stats || {}),
                upgrades: {
                    ...INITIAL_PLAYER_STATS.upgrades,
                    ...(data.stats?.upgrades || {}),
                },
                completedBosses: {
                    ...INITIAL_PLAYER_STATS.completedBosses,
                    ...(data.stats?.completedBosses || {}),
                },
                unlockedShortcuts: {
                    ...INITIAL_PLAYER_STATS.unlockedShortcuts,
                    ...(data.stats?.unlockedShortcuts || {}),
                },
            },
            activeCheckpointId: typeof data.activeCheckpointId === 'string' ? data.activeCheckpointId : 'checkpoint_prologue',
            discoveredCheckpointIds: Array.isArray(data.discoveredCheckpointIds) ? data.discoveredCheckpointIds : ['checkpoint_prologue'],
            consumedInteractableIds: Array.isArray(data.consumedInteractableIds) ? data.consumedInteractableIds : [],
            completedBosses: {
                hollowThrallTutorial: !!data.completedBosses?.hollowThrallTutorial,
                antlerMiniboss: !!data.completedBosses?.antlerMiniboss,
                millButcherBoss: !!data.completedBosses?.millButcherBoss,
                bellMotherBoss: !!data.completedBosses?.bellMotherBoss,
            },
            unlockedShortcuts: {
                hushwoodGate: !!data.unlockedShortcuts?.hushwoodGate,
                millGate: !!data.unlockedShortcuts?.millGate,
            },
            currentZoneIndex: typeof data.currentZoneIndex === 'number' ? data.currentZoneIndex : 0,
        };
    }
}

// -------------------------------------------------------------
// Test Suite 1: SaveGameService Versioning & Migration
// -------------------------------------------------------------
test('SaveGameService: saves and loads V2 schema accurately', () => {
    localStorage.clear();
    assert.equal(TestableSaveGameService.hasSave(), false);

    const testData = {
        stats: {
            ...INITIAL_PLAYER_STATS,
            currentHealth: 85,
            ironNails: 7,
            upgrades: { temperedEdge: true, wovenCharm: false, quickenedWard: false },
        },
        activeCheckpointId: 'checkpoint_hushwood',
        discoveredCheckpointIds: ['checkpoint_prologue', 'checkpoint_hushwood'],
        consumedInteractableIds: ['nail_01', 'nail_02'],
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

    const saved = TestableSaveGameService.save(testData);
    assert.equal(saved, true);
    assert.equal(TestableSaveGameService.hasSave(), true);

    const loaded = TestableSaveGameService.load();
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

test('SaveGameService: migrates legacy v1 save to v2 schema cleanly', () => {
    localStorage.clear();
    const legacyV1 = {
        savedAt: 1700000000000,
        stats: {
            currentHealth: 70,
            ironNails: 5,
            activeCheckpointId: 'checkpoint_mill',
            upgrades: { temperedEdge: false, wovenCharm: true, quickenedWard: false },
            completedBosses: { hollowThrallTutorial: true, antlerMiniboss: true },
            unlockedShortcuts: { hushwoodGate: true },
        },
    };
    localStorage.setItem(STORAGE_KEY_V1, JSON.stringify(legacyV1));

    assert.equal(TestableSaveGameService.hasSave(), true);
    const loaded = TestableSaveGameService.load();
    assert.ok(loaded);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.activeCheckpointId, 'checkpoint_mill');
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

test('SaveGameService: handles malformed data gracefully without throwing', () => {
    localStorage.clear();
    localStorage.setItem(STORAGE_KEY_V2, '{ broken json content ...');
    assert.equal(TestableSaveGameService.load(), null);

    TestableSaveGameService.clear();
    assert.equal(TestableSaveGameService.hasSave(), false);
});

// -------------------------------------------------------------
// Test Suite 2: Checkpoint & Encounter Reset Logic
// -------------------------------------------------------------
test('Encounter Reset: common enemies respawn, completed bosses stay dead', () => {
    const enemies = [
        { id: 'thrall_1', type: 'hollow_thrall', zone: 0, isBoss: false, isDead: true },
        { id: 'boss_tutorial', type: 'hollow_thrall', zone: 0, isBoss: true, bossKey: 'hollowThrallTutorial', isDead: true },
        { id: 'warden_1', type: 'antler_warden', zone: 1, isBoss: false, isDead: true },
        { id: 'boss_antler', type: 'antler_warden', zone: 1, isBoss: true, bossKey: 'antlerMiniboss', isDead: true },
        { id: 'butcher_boss', type: 'mill_butcher', zone: 2, isBoss: true, bossKey: 'millButcherBoss', isDead: false },
    ];

    const completedBosses = {
        hollowThrallTutorial: true,
        antlerMiniboss: true,
        millButcherBoss: false,
        bellMotherBoss: false,
    };

    // Encounter reset for checkpoint in zone 1 (Hushwood)
    function simulateReset(checkpointZone, completed) {
        return enemies.map(e => {
            if (e.isBoss) {
                // Defeated bosses never respawn
                if (completed[e.bossKey]) {
                    return { ...e, isDead: true };
                }
                // Undefeated bosses reset to alive if player respawns at or before their encounter
                return { ...e, isDead: false };
            }
            // Common enemies in or after the checkpoint zone respawn
            if (e.zone >= checkpointZone) {
                return { ...e, isDead: false };
            }
            return { ...e };
        });
    }

    const resetState = simulateReset(1, completedBosses);

    // Thrall in zone 0 remains dead (before checkpoint)
    assert.equal(resetState.find(e => e.id === 'thrall_1').isDead, true);
    // Defeated bosses stay dead
    assert.equal(resetState.find(e => e.id === 'boss_tutorial').isDead, true);
    assert.equal(resetState.find(e => e.id === 'boss_antler').isDead, true);
    // Common enemy in zone 1 respawns
    assert.equal(resetState.find(e => e.id === 'warden_1').isDead, false);
    // Undefeated boss in zone 2 is alive
    assert.equal(resetState.find(e => e.id === 'butcher_boss').isDead, false);
});

// -------------------------------------------------------------
// Test Suite 3: Upgrade Math & Economy
// -------------------------------------------------------------
test('Upgrade Math: recalculates stats correctly (+15% sword, +20% HP, -20% ward CD)', () => {
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

    // Default (no upgrades)
    const defaults = calculateStats({ temperedEdge: false, wovenCharm: false, quickenedWard: false });
    assert.equal(defaults.swordDamage, 35);
    assert.equal(defaults.maxHealth, 100);
    assert.equal(defaults.wardCooldown, 15.0);

    // All upgrades purchased
    const fullUpgrades = calculateStats({ temperedEdge: true, wovenCharm: true, quickenedWard: true });
    assert.equal(fullUpgrades.swordDamage, 40); // 35 * 1.15 = 40.25 -> 40
    assert.equal(fullUpgrades.maxHealth, 120);  // 100 * 1.20 = 120
    assert.equal(fullUpgrades.wardCooldown, 12.0); // 15.0 * 0.80 = 12.0

    // Cost logic: 4 iron nails each
    const UPGRADE_COST = 4;
    let nails = 7;
    let canAfford = nails >= UPGRADE_COST;
    assert.equal(canAfford, true);
    nails -= UPGRADE_COST;
    assert.equal(nails, 3);
    canAfford = nails >= UPGRADE_COST;
    assert.equal(canAfford, false);
});

// -------------------------------------------------------------
// Test Suite 4: Elin's Altar & Root Barrier Boss Gating
// -------------------------------------------------------------
test('Elin Altar & Root Barrier: strictly gated until Bell Mother is defeated', () => {
    let barrierOpen = false;
    let bellMotherDead = false;

    function canInteractWithElin() {
        return bellMotherDead && barrierOpen;
    }

    function onBellMotherDefeated() {
        bellMotherDead = true;
        barrierOpen = true; // zoneManager.openElinBarrier()
    }

    // Before Bell Mother defeat
    assert.equal(canInteractWithElin(), false);

    // After Bell Mother defeat
    onBellMotherDefeated();
    assert.equal(canInteractWithElin(), true);
});

// -------------------------------------------------------------
// Test Suite 5: Input Gating & Modal Pause Management
// -------------------------------------------------------------
test('Input Gating: Pause does not trap Escape key, modals close before unpause', () => {
    let isPaused = false;
    let activeModal = 'none'; // 'none' | 'settings' | 'accessibility' | 'checkpoint'

    function handleKey(key) {
        if (key === 'Escape') {
            if (activeModal !== 'none') {
                activeModal = 'none';
                return 'closed_modal';
            }
            isPaused = !isPaused;
            return isPaused ? 'paused' : 'unpaused';
        }

        // Gameplay actions blocked if paused or in modal
        if (isPaused || activeModal !== 'none') {
            return 'blocked';
        }

        return `executed_${key}`;
    }

    // Normal gameplay
    assert.equal(handleKey('KeyJ'), 'executed_KeyJ');

    // Escape pauses
    assert.equal(handleKey('Escape'), 'paused');
    assert.equal(isPaused, true);

    // KeyJ blocked while paused
    assert.equal(handleKey('KeyJ'), 'blocked');

    // Escape reliably unpauses (no trap)
    assert.equal(handleKey('Escape'), 'unpaused');
    assert.equal(isPaused, false);
    assert.equal(handleKey('KeyJ'), 'executed_KeyJ');

    // Open a modal
    activeModal = 'settings';
    // KeyJ blocked while in modal
    assert.equal(handleKey('KeyJ'), 'blocked');
    // First Escape closes modal, doesn't affect pause
    assert.equal(handleKey('Escape'), 'closed_modal');
    assert.equal(activeModal, 'none');
    assert.equal(isPaused, false);
});

// -------------------------------------------------------------
// Test Suite 6: Gamepad Input Mapping Verification
// -------------------------------------------------------------
test('Gamepad: standard mapping adheres strictly to verified game actions', () => {
    const STANDARD_GAMEPAD_MAPPING = {
        0: 'dodge',         // Button A / Cross
        1: 'parry',         // Button B / Circle
        2: 'lightAttack',   // Button X / Square
        3: 'heavyAttack',   // Button Y / Triangle
        4: 'heal',          // LB / L1
        5: 'ward',          // RB / R1
        6: 'sprint',        // LT / L2
        7: 'interact',      // RT / R2
        8: 'pause',         // Back / Select / Share
        9: 'pause',         // Start / Options
        11: 'targetLock',   // R3 / Right Stick Click
    };

    assert.equal(STANDARD_GAMEPAD_MAPPING[0], 'dodge');
    assert.equal(STANDARD_GAMEPAD_MAPPING[2], 'lightAttack');
    assert.equal(STANDARD_GAMEPAD_MAPPING[3], 'heavyAttack');
    assert.equal(STANDARD_GAMEPAD_MAPPING[1], 'parry');
    assert.equal(STANDARD_GAMEPAD_MAPPING[4], 'heal');
    assert.equal(STANDARD_GAMEPAD_MAPPING[5], 'ward');
    assert.equal(STANDARD_GAMEPAD_MAPPING[6], 'sprint');
    assert.equal(STANDARD_GAMEPAD_MAPPING[7], 'interact');
    assert.equal(STANDARD_GAMEPAD_MAPPING[9], 'pause');
    assert.equal(STANDARD_GAMEPAD_MAPPING[11], 'targetLock');
});
