/**
 * Game Constants Interface
 * 
 * Defines all configurable constants used throughout the engine.
 * Templates can override these values by providing their own Constants.ts
 */
export interface GameConstants {
    /**
     * Interaction range in world units
     * Default: 3.0
     */
    interactionRange: number;
}

/**
 * Default engine constants
 * These are used when no template-specific constants are provided
 */
export const DEFAULT_CONSTANTS: GameConstants = {
    interactionRange: 3.0,
};

/**
 * Merge template constants with engine defaults
 * Template constants override engine defaults
 */
export function mergeConstants(templateConstants?: Partial<GameConstants>): GameConstants {
    return {
        ...DEFAULT_CONSTANTS,
        ...templateConstants,
    };
}

