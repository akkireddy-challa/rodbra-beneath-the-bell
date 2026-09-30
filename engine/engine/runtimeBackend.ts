/**
 * Which game-server a runtime-AI call actually goes to.
 *
 * `AI_CHAT_URL` points at `localhost:1666` whenever the game is served over
 * plain http (config.ts). That is right for the monorepo dev stack, which runs
 * game-server as part of `pnpm run dev` — and wrong everywhere else that serves
 * over http, most of all a `bitmagic dev` project, where nothing listens on
 * 1666 at all and every runtime-AI call fails with a connection error.
 *
 * So the local server is treated as an OPTIONAL upgrade rather than the only
 * option: probe its `/health` once, use it for what it can actually serve, and
 * fall back to the deployed game-server for the rest. That is what the rest of
 * the engine already does — `GAME_DATA_SERVICE_URL` and the multiplayer socket
 * point at the hosted server unconditionally, localhost included — and what the
 * `bitmagic dev --mobile` TLS lane gets for free today, since https skips the
 * localhost branch entirely.
 *
 * The split between the features is deliberate:
 * - `chat` follows REACHABILITY. A developer who started game-server pointed it
 *   at their own OpenRouter key or a local Ollama on purpose, and must keep
 *   getting it.
 * - Everything else follows the CAPABILITY FLAGS, because a local game-server
 *   with no Asset Forger credentials answers 503 to all three. That is the
 *   ordinary case in this repo: `game-server/.env` carries no ASSET_FORGER_*.
 *   `decisions` is the same shape: a local game-server whose chat runs on
 *   Ollama has no decision model behind it and answers 503.
 */

import { AI_CHAT_URL, GAME_SERVER_HTTP_URL } from 'engine/config.js';

/** The runtime-AI calls that can each land on a different server. */
export type RuntimeBackendFeature = 'chat' | 'speechToText' | 'imageGeneration' | 'meshGeneration' | 'decisions';

/**
 * The subset of game-server's `/health` we read. Every field is optional on the
 * wire: an older deployed game-server predates `meshGeneration`, and a missing
 * flag has to mean "cannot serve it" — routing to a local server that answers
 * 503 would be strictly worse than routing to the hosted one.
 */
interface GameServerHealth {
    speechToText?: boolean;
    imageGeneration?: boolean;
    meshGeneration?: boolean;
    decisions?: boolean;
}

/** Short: the probe sits in front of the first runtime-AI call of the session. */
const PROBE_TIMEOUT_MS = 3000;

let healthProbe: Promise<GameServerHealth | null> | null = null;
const announced = new Set<RuntimeBackendFeature>();

/**
 * True only in the lane where AI_CHAT_URL was rewritten to localhost. On https
 * — published games, beta, the Creator, the mobile bridge with TLS — AI_CHAT_URL
 * is already the hosted server, so there is nothing to resolve and nothing to
 * probe. Keeping the probe off that path matters: it would otherwise fire on
 * every visitor's browser.
 */
function isLocalHttpLane(): boolean {
    return typeof window !== 'undefined' && window.location?.protocol === 'http:';
}

/**
 * The deployed game-server to fall back to. `GAME_SERVER_HTTP_URL` picks dev vs
 * prod from the hostname, which reads localhost as neither — so an embedder that
 * knows better (the `bitmagic dev` shell, which knows the project's pinned
 * environment) can say so via `window.BITMAGIC_GAME_SERVER_URL`, the same way it
 * already hands over `window.AI_AGENT_URL`.
 */
function hostedUrl(): string {
    const override = (globalThis as { BITMAGIC_GAME_SERVER_URL?: string }).BITMAGIC_GAME_SERVER_URL;
    return override || GAME_SERVER_HTTP_URL;
}

/** Ask the local game-server what it can do. Null for "not there, or not usable". */
function probeLocalHealth(): Promise<GameServerHealth | null> {
    if (!healthProbe) {
        healthProbe = (async () => {
            try {
                const response = await fetch(`${AI_CHAT_URL}/health`, {
                    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
                });
                if (!response.ok) return null;
                return (await response.json()) as GameServerHealth;
            } catch {
                return null;
            }
        })();
    }
    return healthProbe;
}

/**
 * Say it once per feature. Silently sending a developer's calls to a different
 * server than the one they think they are running is exactly the confusion this
 * module exists to end, so the redirect stays visible — just not once per call.
 */
function useHosted(feature: RuntimeBackendFeature, reason: string): string {
    const url = hostedUrl();
    if (!announced.has(feature)) {
        announced.add(feature);
        console.info(`[runtimeBackend] ${feature} → ${url} (${reason})`);
    }
    return url;
}

/**
 * The base URL for one runtime-AI feature, e.g. `https://game-server.bitmagic.ai`.
 * The `/health` probe behind it runs at most once per page.
 */
export async function resolveRuntimeBackendUrl(feature: RuntimeBackendFeature): Promise<string> {
    if (!isLocalHttpLane()) return AI_CHAT_URL;

    const health = await probeLocalHealth();
    if (health === null) {
        return useHosted(feature, `no game-server answered at ${AI_CHAT_URL}`);
    }
    if (feature === 'chat' || health[feature] === true) {
        return AI_CHAT_URL;
    }
    return useHosted(feature, `the local game-server reports ${feature} unconfigured`);
}
