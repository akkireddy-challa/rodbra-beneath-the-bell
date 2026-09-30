import type { PlayerLifeSnapshot, StateMessage } from 'engine/networking/NetworkTypes.js';

/** Life state survives missing visuals and reliable-delivery retries. */
export class PlayerLifeStateStore {
    private readonly players = new Map<string, Readonly<PlayerLifeSnapshot>>();

    get(playerId: string): Readonly<PlayerLifeSnapshot> | null {
        return this.players.get(playerId) ?? null;
    }

    /** Only the owner's player object can advertise its life state. */
    apply(message: StateMessage): boolean {
        if (message.networkId !== `${message.senderId}:player`) return false;
        const life = message.playerLifeState;
        if (!life || (life.state !== 'alive' && life.state !== 'dead') ||
            !Number.isSafeInteger(life.revision) || life.revision < 0) return false;
        const previous = this.players.get(message.senderId);
        if (previous && life.revision <= previous.revision) return false;
        this.players.set(message.senderId, Object.freeze({ state: life.state, revision: life.revision }));
        return true;
    }

    remove(playerId: string): void { this.players.delete(playerId); }
    clear(): void { this.players.clear(); }
}
