import { isDevelopment, isProduction } from 'engine/environment.js';

// Service URLs configuration - dynamically determined based on current environment
// For production: uses the current hostname with path-based routing
// For development: uses localhost with port-based routing

function getServiceUrl(port: number): string {
  // Check if we're running in a browser environment
  if (typeof window !== 'undefined' && window.location) {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;

    // In production (HTTPS), use path-based routing instead of ports
    if (protocol === 'https:') {
      return `${protocol}//${hostname}/port${port}`;
    }

    // In development (HTTP), use port-based routing
    return `${protocol}//${hostname}:${port}`;
  }
  // Fallback for Node.js environment (tests, etc.)
  return `http://localhost:${port}`;
}

export function getWebSocketUrl(port: number): string {
  // Check if we're running in a browser environment
  if (typeof window !== 'undefined' && window.location) {
    const protocol = window.location.protocol;
    const hostname = window.location.hostname;

    // In production (HTTPS), use path-based routing with wss protocol
    if (protocol === 'https:') {
      return `wss://${hostname}/port${port}`;
    }

    // In development (HTTP), use port-based routing with ws protocol
    return `ws://${hostname}:${port}`;
  }
  // Fallback for Node.js environment (tests, etc.)
  return 'ws://localhost:8082';
}

export function getGameServerUrl(port: number): string {
  const wsUrl = getWebSocketUrl(port);
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

// Game relay server — Cloud Run for multiplayer
// Published games on bitmagic.ai use prod, beta.portal uses dev, creator editor always uses dev
const DEV_GAME_SERVER_URL = 'https://beta.game-server.bitmagic.cloud';
const PROD_GAME_SERVER_URL = 'https://game-server.bitmagic.ai';

function getMultiplayerServerUrl(): string {
  return isProduction() ? PROD_GAME_SERVER_URL : DEV_GAME_SERVER_URL;
}

const GAME_SERVER_URL = getMultiplayerServerUrl();
export const GAME_SERVER_WS_URL = GAME_SERVER_URL.replace(/^https:/, 'wss:');
export const GAME_SERVER_HTTP_URL = GAME_SERVER_URL;

// Ports are read from Vite env vars so a parallel clone checkout can override
// them via a root .env.local (see repo root .env.local.example). The vite.config
// injects VITE_GAME_SERVER_PORT / VITE_GAME_PLAY_AGENT_PORT / VITE_RELOAD_WATCHER_PORT
// via `define` when the corresponding shell env vars are set. Engine code is
// served by dev-server.cjs (plain Node HTTP), which does no transformation, so
// `import.meta.env` can be undefined at runtime — guard with optional chaining.
const GAME_SERVER_LOCAL_PORT = Number(import.meta.env?.VITE_GAME_SERVER_PORT) || 1666;
const AI_AGENT_PORT = Number(import.meta.env?.VITE_GAME_PLAY_AGENT_PORT) || 4111;
const RELOAD_WATCHER_PORT = Number(import.meta.env?.VITE_RELOAD_WATCHER_PORT) || 8082;

// Experimental MacBook-lid sensor stream (localhost only). A local helper server
// emits SSE `data: {"angle":..,"velocity":..,"ts":..}` lines as the lid moves.
// Hardcoded 127.0.0.1 is intentional — the feature is gated to local environments
// (see LidSensorControls). Override the port via VITE_LID_SENSOR_PORT for a clone.
const LID_SENSOR_PORT = Number(import.meta.env?.VITE_LID_SENSOR_PORT) || 8765;
export const LID_SENSOR_STREAM_URL = `http://127.0.0.1:${LID_SENSOR_PORT}/stream`;

// Runtime AI — localhost game-server in dev, Cloud Run in production
export const AI_CHAT_URL = (typeof window !== 'undefined' && window.location?.protocol === 'http:')
  ? `http://${window.location.hostname}:${GAME_SERVER_LOCAL_PORT}`
  : GAME_SERVER_URL;

export const AI_AGENT_URL = getServiceUrl(AI_AGENT_PORT);
export const WEBSOCKET_URL = getWebSocketUrl(RELOAD_WATCHER_PORT);

// Game data service (per-game arbitrary JSON storage) — ALWAYS the deployed
// Cloud Run game-server, including from local HTTP dev. This is the
// multiplayer-persistence layer: writes to Firestore (which local game-server
// doesn't have credentials for) and serves as the shared backend for every
// client on a given game. Multiplayer state must go through one canonical
// store, and that's the cloud one. WS multiplayer (GAME_SERVER_WS_URL above)
// goes to the same cloud host for the same reason. AI chat above is fine to
// run locally (no Firestore dependency) and respects the HTTP-dev shortcut.
export const GAME_DATA_SERVICE_URL = GAME_SERVER_URL;

// Default renderer for direct game loads with no URL ?renderer=, no meta tag,
// and no localStorage. Override via VITE_DEFAULT_RENDERER=webgl|webgpu.
export const DEFAULT_RENDERER_TYPE: 'webgl' | 'webgpu' =
    import.meta.env?.VITE_DEFAULT_RENDERER === 'webgl' ? 'webgl' : 'webgpu';

// Portal backend API (api-server) — hosts the play-session heartbeat and
// achievement-unlock endpoints the engine's progress subsystem calls (P6).
// This is NOT GAME_DATA_SERVICE_URL (that's the game-server, a different host).
// An explicit VITE_API_SERVER_BASE_URL wins (parallel-clone / custom deploys);
// otherwise fall back by runtime environment, because the game bundle is often
// served untransformed (dev-server.cjs) so import.meta.env is absent, and a bare
// localhost default would break published prod games. The hosts mirror the
// portal deploy workflow's VITE_API_SERVER_BASE_URL per environment (prod =
// bitmagic.ai, dev cluster = beta.portal.bitmagic.cloud); environment comes
// from the live hostname (engine/environment.ts).
export const API_SERVER_BASE_URL = (
    import.meta.env?.VITE_API_SERVER_BASE_URL
    || (isProduction() ? 'https://bitmagic.ai'
        : isDevelopment() ? 'https://beta.portal.bitmagic.cloud'
        : 'http://localhost:3002')
).replace(/\/$/, '');

// Shared X-API-Token for api-server. verifyApiToken gates most /api/* routes on
// this, but the game-called [play] endpoints (/api/play/sessions*,
// /api/play/achievements*) are EXEMPT — they authenticate with the scoped play
// Bearer instead (see api-server src/play/play-public-paths.ts). The exemption
// exists precisely because the published game bundle is served untransformed, so
// import.meta.env is absent and VITE_API_TOKEN can never bake in: this value is
// always 'localhost-token' at runtime and is sent as a best-effort header the
// play routes ignore. Do NOT rely on it for any non-exempt api-server route from
// engine code. Mirrors the portal's API_TOKEN; 'localhost-token' is also the
// api-server's local-dev default.
export const API_SERVER_TOKEN = import.meta.env?.VITE_API_TOKEN || 'localhost-token';

// Portal-origin play-auth bridge page. PlayerIdentity embeds it as a hidden
// iframe and speaks the BM_PLAY_TOKEN_REQUEST/RESPONSE protocol to obtain a
// scoped play token. Empty (local dev default) means "no play-auth origin", so
// PlayerIdentity resolves every player to guest without embedding anything.
export const PLAY_AUTH_URL = import.meta.env?.VITE_PLAY_AUTH_URL
    || (isProduction() ? 'https://bitmagic.ai/play-auth.html'
        : isDevelopment() ? 'https://beta.portal.bitmagic.cloud/play-auth.html'
        : '');
