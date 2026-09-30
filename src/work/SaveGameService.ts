import type { PlayerStats } from './Constants.js';
import { INITIAL_PLAYER_STATS } from './Constants.js';

export interface SaveDataV2 {
    version: 2;
    timestamp: number;
    stats: PlayerStats;
    activeCheckpointId: string;
    discoveredCheckpointIds: string[];
    consumedInteractableIds: string[];
    completedBosses: {
        hollowThrallTutorial: boolean;
        antlerMiniboss: boolean;
        millButcherBoss: boolean;
        bellMotherBoss: boolean;
    };
    unlockedShortcuts: {
        hushwoodGate: boolean;
        millGate: boolean;
    };
    currentZoneIndex: number;
}

const STORAGE_KEY_V2 = 'rodbra_save_v2';
const STORAGE_KEY_V1 = 'rodbra_save_v1';

export class SaveGameService {
    /**
     * Save current game progress with complete world and progression state
     */
    public static save(data: Omit<SaveDataV2, 'version' | 'timestamp'>, engine?: any): boolean {
        try {
            const payload: SaveDataV2 = {
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

            const serialized = JSON.stringify(payload);
            localStorage.setItem(STORAGE_KEY_V2, serialized);

            // Also synchronize with Bitmagic engine persistence if available
            try {
                const persistence = engine?.getGamePersistence?.();
                persistence?.save(payload, 'default', `Checkpoint: ${payload.activeCheckpointId}`);
            } catch (_) {}

            return true;
        } catch (e) {
            console.error('Failed to save game data:', e);
            return false;
        }
    }

    /**
     * Load game data with version validation and automatic v1 migration
     */
    public static load(): SaveDataV2 | null {
        try {
            // 1. Try to load v2 format
            const rawV2 = localStorage.getItem(STORAGE_KEY_V2);
            if (rawV2) {
                const parsed = JSON.parse(rawV2);
                if (parsed && parsed.version === 2 && parsed.stats) {
                    return this.validateAndSanitize(parsed);
                }
            }

            // 2. Migration from v1 format if present
            const rawV1 = localStorage.getItem(STORAGE_KEY_V1);
            if (rawV1) {
                const parsedV1 = JSON.parse(rawV1);
                if (parsedV1 && parsedV1.stats) {
                    console.log('Migrating legacy save v1 to v2 format...');
                    const migrated: SaveDataV2 = {
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
                    // Save the migrated data
                    this.save(migrated);
                    return migrated;
                }
            }

            return null;
        } catch (e) {
            console.error('Failed to load save data:', e);
            return null;
        }
    }

    /**
     * Check if a valid save game exists
     */
    public static hasSave(): boolean {
        return !!localStorage.getItem(STORAGE_KEY_V2) || !!localStorage.getItem(STORAGE_KEY_V1);
    }

    /**
     * Clear all saved progress for a true New Game reset
     */
    public static clear(engine?: any): void {
        try {
            localStorage.removeItem(STORAGE_KEY_V2);
            localStorage.removeItem(STORAGE_KEY_V1);

            try {
                const persistence = engine?.getGamePersistence?.();
                persistence?.clear?.('default');
            } catch (_) {}
        } catch (e) {
            console.error('Failed to clear save data:', e);
        }
    }

    /**
     * Validate and sanitize parsed save payload
     */
    private static validateAndSanitize(data: any): SaveDataV2 {
        const stats: PlayerStats = {
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
        };

        return {
            version: 2,
            timestamp: typeof data.timestamp === 'number' ? data.timestamp : Date.now(),
            stats,
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
