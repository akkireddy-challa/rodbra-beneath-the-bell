# engine-api-identity

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/identity/PlayerIdentity.ts
interface PlayTokenResult — The token bridge answers with a token (or null for guests) plus its expiry.
PlayTokenResult.token: string | null
PlayTokenResult.expiresAt: number | null
const PLAY_TOKEN_REFRESH_BUFFER_MS = 60_000
const PLAY_TOKEN_GUEST_TTL_MS = 30_000
class PlayTokenCache — PURE token cache. Holds the last handshake result and decides when to re-fetch:
PlayTokenCache.constructor(private readonly fetchToken: () => Promise<PlayTokenResult>, private readonly now: () => number = () => Date.now())
PlayTokenCache.getToken(): Promise<string | null>
PlayTokenCache.invalidate(): void
class PlayerIdentity — DOM handshake client. Lazily embeds the hidden play-auth iframe on first token
PlayerIdentity.constructor(private readonly playAuthUrl: string = PLAY_AUTH_URL)
PlayerIdentity.getPlayerToken(): Promise<string | null>
PlayerIdentity.reportGuestUnlock(achievementId: string): void
PlayerIdentity.sendGuestHeartbeat(beat: { visible: boolean; active: boolean; visibleMs: number }): void
PlayerIdentity.dispose(): void
function getPlayerIdentity(): PlayerIdentity
