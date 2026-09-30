# engine-api-progress

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/progress/AchievementToast.ts
interface AchievementToastEntry — What the toast needs to render one unlock.
AchievementToastEntry.name: string
AchievementToastEntry.imageUrl?: string | null
AchievementToastEntry.xp?: number
const ACHIEVEMENT_TOAST_MS = 4200
function escapeHtml(value: string): string
function buildToastHtml(entry: AchievementToastEntry): string
class AchievementToast
AchievementToast.show(entry: AchievementToastEntry): void
AchievementToast.dispose(): void

## engine/progress/ActivityTracker.ts
const IDLE_AFTER_MS = 3 * 60_000
const GAMEPAD_POLL_MS = 2_000
function isActive(lastInputMs: number, nowMs: number, idleAfterMs: number = IDLE_AFTER_MS): boolean
function gamepadSignature(pads: ReadonlyArray<Gamepad | null>): string
class ActivityTracker
ActivityTracker.constructor(private readonly idleAfterMs: number = IDLE_AFTER_MS)
ActivityTracker.start(): void
ActivityTracker.stop(): void
ActivityTracker.isActive(nowMs: number = Date.now()): boolean

## engine/progress/LoadProgress.ts
type LoadPhaseId = 'boot' | 'data' | 'physics' | 'genre' | 'world' | 'assets' | 'warmup'
const LOAD_PHASE_WEIGHTS: Record<LoadPhaseId, number>
const LOAD_PHASE_ORDER: readonly LoadPhaseId[]
function overallFraction(phase: LoadPhaseId, phaseFraction: number): number
interface LoadProgressSnapshot
LoadProgressSnapshot.fraction: number
LoadProgressSnapshot.phase: LoadPhaseId | null
LoadProgressSnapshot.label: string
type LoadProgressListener = (snapshot: LoadProgressSnapshot) => void
class LoadProgressTracker
LoadProgressTracker.reset(): void
LoadProgressTracker.beginPhase(phase: LoadPhaseId, label?: string): void
LoadProgressTracker.setPhaseFraction(phaseFraction: number, label?: string): void
LoadProgressTracker.reportItems(done: number, total: number, label?: string): void
LoadProgressTracker.setLabel(label: string): void
LoadProgressTracker.complete(): void
LoadProgressTracker.getSnapshot(): LoadProgressSnapshot
LoadProgressTracker.addListener(listener: LoadProgressListener): void
LoadProgressTracker.removeListener(listener: LoadProgressListener): void
function getLoadProgress(): LoadProgressTracker
function handoffBootShell(): void
type WorldSubSignal = 'terrain-fetch' | 'splat-fetch' | 'objects'
function reportWorldSubProgress(signal: WorldSubSignal, fraction: number, label?: string): void

## engine/progress/PlaySessionClient.ts
const EARLY_MEASURE_AT_MS: readonly number[]
const DEFAULT_ACHIEVEMENT_TOAST = 'Achievement unlocked'
function heartbeatPayload(documentHidden: boolean, active: boolean = true): { visible: boolean; active: boolean }
type HeartbeatAction = 'ok' | 'restart' | 'skip' | 'error'
function classifyHeartbeatStatus(status: number): HeartbeatAction
class SessionUnlockDedup — Per-session unlock dedup. `claim(id)` returns true the first time an id is seen
SessionUnlockDedup.claim(id: string): boolean
SessionUnlockDedup.reset(): void
interface AchievementToastDef — What the unlock toast needs about an achievement, indexed from game data.
AchievementToastDef.name: string
AchievementToastDef.imageUrl: string | null
AchievementToastDef.xp: number
function buildAchievementDefMap(defs: ReadonlyArray<{ achievementId?: unknown; name?: unknown; imageUrl?: unknown; xp?: unknown }> | undefined | null): Map<string, AchievementToastDef>
interface PlayProgressDeps
PlayProgressDeps.getPlayerToken: () => Promise<string | null>
PlayProgressDeps.showUnlock: (entry: { name: string; imageUrl: string | null; xp: number }) => void
PlayProgressDeps.reportGuestUnlock: (achievementId: string) => void
PlayProgressDeps.sendGuestHeartbeat: (beat: { visible: boolean; active: boolean; visibleMs: number }) => void
class PlayProgressClient — Owns the live session lifecycle and the unlock path. Constructed once and
PlayProgressClient.constructor(private readonly deps: PlayProgressDeps)
PlayProgressClient.configure(gameId: string, defs: Map<string, AchievementToastDef>): void
PlayProgressClient.startSession(): void
PlayProgressClient.unlockAchievement(id: string): void
PlayProgressClient.stop(): void
function installPlayProgress(deps: PlayProgressDeps): PlayProgressClient
function getPlayProgress(): PlayProgressClient | null

## engine/progress/VisibleClock.ts
class VisibleClock — Running visible time for one play session.
VisibleClock.constructor(nowMs: number, visible: boolean)
VisibleClock.hide(nowMs: number): void
VisibleClock.show(nowMs: number): void
VisibleClock.elapsed(nowMs: number): number

## engine/progress/installEngineProgress.ts
function installEngineProgress(toast: AchievementToast): void
