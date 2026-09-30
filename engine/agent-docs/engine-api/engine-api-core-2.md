# engine-api-core-2

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/WarmupPolicy.ts
type WarmupMode = 'full' | 'nocompile' | 'culled' | 'light' | 'off'
interface WarmupPolicy — What a mode actually switches on.
WarmupPolicy.compile: boolean
WarmupPolicy.uncullScene: boolean
WarmupPolicy.revealEmptyInstanced: boolean
WarmupPolicy.frame: boolean
function warmupPolicyFor(mode: WarmupMode): WarmupPolicy
function isWarmupMode(value: string): value is WarmupMode
function resolveWarmupMode(fallback: WarmupMode): WarmupMode

## engine/agentUrl.ts
function getAgentUrl(): string

## engine/config.ts
function getWebSocketUrl(port: number): string
function getGameServerUrl(port: number): string
const GAME_SERVER_WS_URL = GAME_SERVER_URL.replace(/^https:/, 'wss:')
const GAME_SERVER_HTTP_URL = GAME_SERVER_URL
const LID_SENSOR_STREAM_URL = `http://127.0.0.1:${LID_SENSOR_PORT}/stream`
const AI_CHAT_URL = (typeof window !== 'undefined' && window.location?.protocol
const AI_AGENT_URL = getServiceUrl(AI_AGENT_PORT)
const WEBSOCKET_URL = getWebSocketUrl(RELOAD_WATCHER_PORT)
const GAME_DATA_SERVICE_URL = GAME_SERVER_URL
const DEFAULT_RENDERER_TYPE: 'webgl' | 'webgpu'
const API_SERVER_BASE_URL = ( import.meta.env?.VITE_API_SERVER_BASE_URL || (isProduction
const API_SERVER_TOKEN = import.meta.env?.VITE_API_TOKEN || 'localhost-token'
const PLAY_AUTH_URL = import.meta.env?.VITE_PLAY_AUTH_URL || (isProduction() ? 'ht

## engine/gzip.ts
function gzip(input: Uint8Array): Promise<Uint8Array>
function gunzip(input: Uint8Array): Promise<Uint8Array>

## engine/renderSyncPosition.ts
interface RenderSyncPosition — The plain `{x, y, z}` shape shared by a RAPIER `translation()` and a
RenderSyncPosition.x: number
RenderSyncPosition.y: number
RenderSyncPosition.z: number
const RENDER_SYNC_MAX_DIVERGENCE = 2
function resolveRenderSyncPosition(smooth: THREE.Vector3 | null | undefined, body: RenderSyncPosition): RenderSyncPosition

## engine/runtimeBackend.ts
type RuntimeBackendFeature = 'chat' | 'speechToText' | 'imageGeneration' | 'meshGeneration' | 'decisions'
function resolveRuntimeBackendUrl(feature: RuntimeBackendFeature): Promise<string>

## engine/syncGroundWorldSizeToBakedLevel.ts
interface XZBounds — The X/Z footprint of a baked level — the subset of the terrain systems' bounds we need.
XZBounds.minX: number
XZBounds.maxX: number
XZBounds.minZ: number
XZBounds.maxZ: number
function syncGroundWorldSizeToBakedLevel(engine: EngineLike, bounds: XZBounds): void
