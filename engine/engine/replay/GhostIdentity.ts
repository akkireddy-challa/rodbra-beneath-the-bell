/**
 * Who a board row belongs to.
 *
 * Not only a recorded run: a plain high-score table has exactly the same
 * problem, and a score written without this is a row the website cannot
 * attribute to anyone. Both lanes resolve their player here, which is why
 * `GameEngine` — not `GhostRacing` — owns the instance.
 *
 * Two kinds of player, one mechanism (design §10.3). Every player holds a
 * `playerId` that is published with their runs and a `verifier` that is NOT —
 * the verifier is a bearer credential proving the client was issued that id,
 * and reads on the game data service are public, so writing it into an entry
 * would hand it to everyone.
 *
 * The credential is issued FOR THIS GAME and rejected on any other. It has to
 * be: this store is localStorage on an origin shared by every published game,
 * so another game's script can read it, and an unscoped credential would let
 * that script write as this player on every board in the environment. Guest
 * credentials are minted per game; account credentials are scoped by api-server
 * to the game its play token was issued for.
 *
 * - Guests get a server-minted `g_<random>` id and a generated display name.
 * - Signed-in players get their account's `publicId`, issued against a verified
 *   play token. Never the auth0 sub, which must not appear in public data.
 *
 * Signing in does not rewrite history: the anon id is LINKED to the account and
 * the read path resolves the alias, so past runs surface under the new name.
 */

import { GAME_DATA_SERVICE_URL, API_SERVER_BASE_URL } from 'engine/config.js';
import type { GamePersistence } from 'engine/persistence/GamePersistence.js';
import { ANON_PLAYER_PREFIX, generatedNameFor, isAnonymousPlayerId } from 'engine/replay/GhostNames.js';

/** Storage slot holding the local identity. Never leaves the device. */
export const GHOST_IDENTITY_SLOT = 'ghost-identity';

export interface GhostCredential {
    /** Published with every run. A `publicId`, or `g_<random>` for a guest. */
    playerId: string;
    /** Bearer credential. Sent on writes, NEVER stored in an entry. */
    verifier: string;
}

export interface StoredGhostIdentity extends GhostCredential {
    /** The anon id this device started with, if it has since been linked. */
    linkedFrom: string | null;
}

/**
 * Who this device writes leaderboard rows as — the whole answer, in one object.
 *
 * Exists because a board write needs THREE things that must agree with each
 * other: the id the row is stamped with, the credential proving it, and the
 * name to render. Handing them out through separate calls invites a game to
 * take the id and skip the credential, which is exactly the row a board cannot
 * attribute — it renders as a generated guest name with no avatar and no
 * profile link, no matter who was signed in.
 *
 * ⚠ `verifier` is a bearer credential. Pass it to `GameDataService.create()`
 * and nowhere else: never into `data` or `values` (reads are public), never to
 * another service, never on screen.
 */
export interface LeaderboardIdentity {
    /** Published owner of the row. An account's `publicId`, or `g_<random>`. */
    playerId: string;
    /** Proves `playerId`. Sent on the write, NEVER stored in the entry. */
    verifier: string;
    /** The name to show. The account's profile name, or a generated one. */
    displayName: string;
    /** True when this is a generated guest, not a signed-in account. */
    isGuest: boolean;
}

/** Supplies the play token proving the signed-in account. */
export type PlayTokenSource = () => Promise<string | null>;

export interface GhostIdentityOptions {
    gameDataServiceUrl: string;
    portalApiUrl: string;
    gameId: string;
}

export const DEFAULT_GHOST_IDENTITY_OPTIONS: GhostIdentityOptions = {
    gameDataServiceUrl: GAME_DATA_SERVICE_URL,
    portalApiUrl: API_SERVER_BASE_URL,
    gameId: '',
};

/**
 * Every string here arrives from JSON — a service response or a storage slot —
 * so it is untrusted, and a blank id or verifier is as unusable as a missing
 * one: it would stamp a row nobody can be resolved from.
 */
function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

export class GhostIdentity {
    private current: StoredGhostIdentity | null = null;
    private cachedDisplayName: string | null = null;
    private inflight: Promise<GhostCredential> | null = null;

    constructor(
        private readonly options: GhostIdentityOptions,
        private readonly persistence: GamePersistence,
        private readonly playToken: PlayTokenSource,
    ) {}

    /**
     * The credential to write runs with, minting or restoring one as needed.
     *
     * An ACCOUNT always wins over a guest identity, and the upgrade is retried
     * on every resolve that would otherwise hand back an anonymous id. Doing it
     * here rather than at some sign-in callback is what makes the promotion
     * unmissable: a player signs in before the game loads, in another tab, or
     * between two laps, and a run written under the stale guest id publishes
     * their lap under a generated name that is not theirs. The play token is
     * cached (`PlayTokenCache`) and answers null for guests without a network
     * call, so the retry costs a guest nothing.
     *
     * Concurrent callers share one in-flight mint — a race here would burn two
     * anon ids and split one player across two rows on the board.
     */
    async resolve(): Promise<GhostCredential> {
        if (this.current && !isAnonymousPlayerId(this.current.playerId)) return this.current;
        if (this.inflight) return this.inflight;

        this.inflight = (async (): Promise<GhostCredential> => {
            // Best effort, and deliberately not fatal: an account whose upgrade
            // cannot be reached still races, still records, and still keeps its
            // ghost — under the guest identity, which the next resolve retries.
            const account = await this.upgradeToAccount().catch((error: unknown) => {
                console.warn('[GhostIdentity] resolving the account identity failed — racing as a guest:', error);
                return null;
            });
            if (account) return account;

            const stored = this.current ?? this.loadStored();
            if (stored) {
                this.current = stored;
                return stored;
            }
            const minted = await this.mintAnonymous();
            const identity: StoredGhostIdentity = { ...minted, linkedFrom: null };
            this.store(identity);
            this.current = identity;
            return identity;
        })();

        try {
            return await this.inflight;
        } finally {
            this.inflight = null;
        }
    }

    /**
     * The name this player's runs are published under.
     *
     * Resolved entirely by the engine — a game must NEVER ask the player for
     * one. A signed-in player already chose a name on their profile, and asking
     * again invites a second, conflicting identity. A guest has a generated
     * name derived from their id, which is the whole point of generating it.
     *
     * Guests cost no network at all. An account name is fetched once and
     * cached, falling back to the generated name if the lookup fails, so a
     * finished run never waits on a profile service to be recorded.
     */
    async displayName(): Promise<string> {
        return this.nameFor(await this.resolve());
    }

    /**
     * Everything a leaderboard write needs, resolved together.
     *
     * The name is derived from the credential this call resolved rather than
     * from a second `resolve()`, so the id and the name can never disagree —
     * a row stamped with a guest id but labelled with an account name would
     * dedupe and link as two different players.
     */
    async info(): Promise<LeaderboardIdentity> {
        const identity = await this.resolve();
        return {
            playerId: identity.playerId,
            verifier: identity.verifier,
            displayName: await this.nameFor(identity),
            isGuest: isAnonymousPlayerId(identity.playerId),
        };
    }

    /** The name for an already-resolved identity. */
    private async nameFor(identity: GhostCredential): Promise<string> {
        if (isAnonymousPlayerId(identity.playerId)) return generatedNameFor(identity.playerId);
        if (this.cachedDisplayName) return this.cachedDisplayName;

        const resolved = await this.fetchAccountName(identity.playerId);
        this.cachedDisplayName = resolved ?? generatedNameFor(identity.playerId);
        return this.cachedDisplayName;
    }

    /** The account's chosen profile name, or null when it cannot be read. */
    private async fetchAccountName(playerId: string): Promise<string | null> {
        try {
            const response = await fetch(`${this.options.portalApiUrl}/api/play/player-refs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playerIds: [playerId] }),
            });
            if (!response.ok) return null;
            const body = (await response.json()) as { refs?: Array<{ displayName: string | null }> };
            const name = body.refs?.[0]?.displayName;
            return isNonEmptyString(name) ? name : null;
        } catch {
            return null;
        }
    }

    /** True when runs are being written under a generated guest identity. */
    isGuest(): boolean {
        return this.current === null || isAnonymousPlayerId(this.current.playerId);
    }

    /**
     * Promote the local identity to the signed-in account.
     *
     * Exchanges the play token for the account's credential and links the anon
     * id so past runs resolve to the new name. Returns the account credential,
     * or null when there is no play token — the normal case for a guest, and
     * not an error.
     *
     * ⚠ `resolve()` already calls this whenever the identity is still
     * anonymous; that is the ONLY thing that must promote it. Wiring a second
     * caller to a sign-in event does not make the promotion more certain, and
     * leaving promotion to such an event is what published every signed-in
     * player's laps under a generated guest name — the same transition that
     * stranded anonymous XP.
     */
    async upgradeToAccount(): Promise<GhostCredential | null> {
        const token = await this.playToken();
        if (!token) return null;

        const previous = this.current ?? this.loadStored();
        const account = await this.fetchAccountIdentity(token);
        if (!account) return null;

        // Only a guest identity is worth linking: an account id is already the
        // one runs resolve to, and linking it to itself would say nothing.
        const guest = previous && isAnonymousPlayerId(previous.playerId) ? previous : null;
        if (guest && guest.playerId !== account.playerId) {
            await this.link(token, guest);
        }

        const identity: StoredGhostIdentity = { ...account, linkedFrom: guest?.playerId ?? null };
        this.store(identity);
        this.current = identity;
        this.cachedDisplayName = null;
        return identity;
    }

    private loadStored(): StoredGhostIdentity | null {
        const { data } = this.persistence.load<StoredGhostIdentity>(GHOST_IDENTITY_SLOT);
        if (!data || !isNonEmptyString(data.playerId) || !isNonEmptyString(data.verifier)) return null;
        return { playerId: data.playerId, verifier: data.verifier, linkedFrom: data.linkedFrom ?? null };
    }

    private store(identity: StoredGhostIdentity): void {
        this.persistence.save(identity, GHOST_IDENTITY_SLOT);
    }

    private async mintAnonymous(): Promise<GhostCredential> {
        const url = `${this.options.gameDataServiceUrl}/v1/identity/anon`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameId: this.options.gameId }),
        });
        if (!response.ok) {
            throw new Error(`ghost identity mint failed: ${response.status}`);
        }
        const body = (await response.json()) as GhostCredential;
        if (!isNonEmptyString(body.playerId) || !body.playerId.startsWith(ANON_PLAYER_PREFIX)) {
            throw new Error('ghost identity mint returned a malformed id');
        }
        return { playerId: body.playerId, verifier: body.verifier };
    }

    /**
     * The account credential for THIS game.
     *
     * No gameId is sent: the play token is bound to one game at issuance, and
     * api-server scopes the verifier to that. Sending one would be a field the
     * server ignores — and if it did not ignore it, a game could ask for a
     * credential good on another game's board.
     */
    private async fetchAccountIdentity(token: string): Promise<GhostCredential | null> {
        const response = await fetch(`${this.options.portalApiUrl}/api/play/ghost-identity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({}),
        });
        if (!response.ok) return null;
        const body = (await response.json()) as GhostCredential;
        if (!isNonEmptyString(body.playerId) || !isNonEmptyString(body.verifier)) return null;
        return { playerId: body.playerId, verifier: body.verifier };
    }

    private async link(token: string, previous: GhostCredential): Promise<void> {
        // Best effort: a failed link costs the player their old rows under the
        // new name, which is a disappointment rather than a broken sign-in.
        try {
            await fetch(`${this.options.portalApiUrl}/api/play/ghost-link`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ anonId: previous.playerId, anonVerifier: previous.verifier }),
            });
        } catch (error) {
            console.warn('[GhostIdentity] linking the guest identity to the account failed:', error);
        }
    }
}
