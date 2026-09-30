import type { GameEngine } from 'engine/GameEngine.js';

export interface GameTemplateContext {
    getGameEngine(): GameEngine | null;
    getCurrentGameData(): any;
    setCurrentGameData(data: any): void;
    safePostMessage(message: any): void;
}
