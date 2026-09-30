# engine-api-playtest

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/playtest/PlaytestGuard.ts
const PLAYTEST_TAG = '[playtest]'
class MemoryStorage implements Storage — In-memory Storage: the page reads and writes normally, nothing persists or leaks.
MemoryStorage.get length(): number
MemoryStorage.clear(): void
MemoryStorage.getItem(key: string): string | null
MemoryStorage.key(index: number): string | null
MemoryStorage.removeItem(key: string): void
MemoryStorage.setItem(key: string, value: string): void
function isReadOnlyMethod(method: string | undefined): boolean
function installPlaytestGuard(): void

## engine/playtest/PlaytestProbe.ts
interface PlaytestReport
PlaytestReport.outcome: PlaytestVerdict['outcome']
PlaytestReport.failures: PlaytestFinding[]
PlaytestReport.warnings: PlaytestFinding[]
PlaytestReport.errors: ForwardedRuntimeError[]
PlaytestReport.screenshot: string | null
PlaytestReport.playedSeconds: number
function runPlaytestProbe(getEngine: () => GameEngine | null): Promise<void>

## engine/playtest/playtestClassify.ts
interface PlaytestSample — One poll of the running page, taken every PLAYTEST_POLL_MS once gameplay starts.
PlaytestSample.atMs: number
PlaytestSample.rafCount: number
PlaytestSample.engineFrames: number | null
PlaytestSample.gameState: string | null
PlaytestSample.playerY: number | null
PlaytestSample.errorCount: number
PlaytestSample.respawnCount: number
const PLAYTEST_POLL_MS = 500
const PLAYTEST_SETTLE = { minSettleMs: 4_000, minFrames: 90, quietMs: 1_500, maxSett
function isFreefalling(samples: readonly PlaytestSample[]): boolean
function hasSettled(samples: readonly PlaytestSample[]): boolean
interface FrameStats — Pixel statistics of the end-of-test frame (see PlaytestProbe.captureFrame).
FrameStats.litFraction: number
FrameStats.distinctColors: number
interface PlaytestEvents
PlaytestEvents.earlyDeaths: number
PlaytestEvents.matchEndAtSeconds: number | null
interface PlaytestObservations
PlaytestObservations.started: boolean
PlaytestObservations.errorsBeforeStart: number
PlaytestObservations.samples: readonly PlaytestSample[]
PlaytestObservations.frame: FrameStats | null
PlaytestObservations.events: PlaytestEvents | null
type PlaytestFailureCode = | 'never_started' | 'start_threw' | 'frame_black' | 'frame_flat' | 'fell_out_of_world' | 'render_stalled'
interface PlaytestFinding
PlaytestFinding.code: string
PlaytestFinding.message: string
interface PlaytestVerdict
PlaytestVerdict.outcome: 'passed' | 'failed' | 'inconclusive'
PlaytestVerdict.failures: PlaytestFinding[]
PlaytestVerdict.warnings: PlaytestFinding[]
function classifyPlaytest(obs: PlaytestObservations): PlaytestVerdict
function frameStats(rgba: ArrayLike<number>, width: number, height: number, step = 4): FrameStats
function summarizeEvents(events: readonly { frame: number; type: string }[]): PlaytestEvents
