/**
 * Jest mock for `engine/config.js`.
 *
 * The real module reads ports from `import.meta.env`, which the ts-jest CJS
 * runtime cannot parse ("Cannot use 'import.meta' outside a module") — it fails
 * at module load, before any test runs. Engine modules pull config in
 * transitively (e.g. VoxelTerrainSystem → StorageUploadUtil → agentUrl →
 * config), so importing almost any engine class into a test hits it.
 *
 * Nothing under test performs network I/O; these are inert stand-ins that keep
 * the import graph loadable. Mirrors the real module's export surface — if you
 * add an export to config.ts that engine code reads at module scope, add it here
 * too or engine tests will fail with `undefined`.
 */

export function getWebSocketUrl(port: number): string {
    return `ws://localhost:${port}`;
}

export function getGameServerUrl(port: number): string {
    return `http://localhost:${port}`;
}

export const GAME_SERVER_WS_URL = 'ws://localhost:1666';
export const GAME_SERVER_HTTP_URL = 'http://localhost:1666';
export const LID_SENSOR_STREAM_URL = 'http://127.0.0.1:8765/stream';
export const AI_CHAT_URL = 'http://localhost:1666';
export const AI_AGENT_URL = 'http://localhost:4111';
export const WEBSOCKET_URL = 'ws://localhost:8082';
export const GAME_DATA_SERVICE_URL = 'http://localhost:1666';
export const DEFAULT_RENDERER_TYPE: 'webgl' | 'webgpu' = 'webgl';
export const API_SERVER_BASE_URL = 'http://localhost:3002';
export const API_SERVER_TOKEN = 'localhost-token';
export const PLAY_AUTH_URL = '';
