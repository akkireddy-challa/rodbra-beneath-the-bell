# engine-api-quality

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/quality/DeviceGpuProbe.ts
interface GpuProbeResult — What the probe saw. `null` where it could not run at all.
GpuProbeResult.msPerFrame: number
GpuProbeResult.tier: DeviceQualityTier
function probeTier(msPerFrame: number, from: DeviceQualityTier): DeviceQualityTier
function runGpuProbe(renderer: THREE.WebGLRenderer, render: () => void, from: DeviceQualityTier, now: () => number = () => performance.now()): Promise<GpuProbeResult | null>

## engine/quality/DeviceQualityApply.ts
type PendingQualityChange = | 'materials' | 'levelDetail' | 'sceneryDetail' | 'characterDetail' | 'effects' | 'shadows'
function applyDeviceTierLive(engine: GameEngine, tier: DeviceQualityTier, source: 'auto' | 'pinned'): PendingQualityChange[]

## engine/quality/FrameBudgetSampler.ts
interface FrameWindow — One window's worth of evidence. The only thing `evaluateWindow` ever sees.
FrameWindow.startMs: number
FrameWindow.endMs: number
FrameWindow.renderedFrames: number
FrameWindow.targetFps: number
FrameWindow.droppedFrames: number
FrameWindow.worstGapMs: number
FrameWindow.busyMsSum: number
FrameWindow.busyMsMax: number
FrameWindow.renderMsSum: number
FrameWindow.programDelta: number
FrameWindow.geometryDelta: number
FrameWindow.textureDelta: number
FrameWindow.disturbed: boolean
const DROPPED_FRAME_FACTOR = 1.75
interface RendererCounters — Renderer counters the sampler reads once per window, never per frame.
RendererCounters.programs: number
RendererCounters.geometries: number
RendererCounters.textures: number
class FrameBudgetSampler — Accumulates frames and emits a `FrameWindow` when one is full.
FrameBudgetSampler.constructor(private readonly windowMs: number)
FrameBudgetSampler.noteDisturbance(): void
FrameBudgetSampler.recordFrame(nowMs: number, gapMs: number, busyMs: number, renderMs: number, targetFps: number, counters: RendererCounters): FrameWindow | null
FrameBudgetSampler.reset(): void

## engine/quality/QualityAutoTune.ts
type AutoTuneDecision = | { kind: 'none' } | { kind: 'discard'; why: DiscardReason } | { kind: 'downgrade'; why: string }
type DiscardReason = 'grace' | 'compile' | 'streaming' | 'disturbed' | 'short' | 'cooldown'
interface AutoTuneState — The tuner's carried state. Immutable — `evaluateWindow` returns the next one.
AutoTuneState.consecutiveBad: number
AutoTuneState.quietUntilMs: number
AutoTuneState.downgradesUsed: number
interface AutoTuneConfig
AutoTuneConfig.windowMs: number
AutoTuneConfig.badFpsFraction: number
AutoTuneConfig.badDroppedRatio: number
AutoTuneConfig.consecutiveBadWindows: number
AutoTuneConfig.graceMs: number
AutoTuneConfig.regraceMs: number
AutoTuneConfig.cooldownMs: number
AutoTuneConfig.maxDowngradesPerSession: number
AutoTuneConfig.minWindowFrames: number
AutoTuneConfig.streamingDelta: number
const DEFAULT_AUTO_TUNE: AutoTuneConfig
function initialAutoTuneState(firstFrameMs: number, cfg: AutoTuneConfig): AutoTuneState
function evaluateWindow(state: AutoTuneState, win: FrameWindow, cfg: AutoTuneConfig): { next: AutoTuneState; decision: AutoTuneDecision }

## engine/quality/QualityController.ts
type TierChangeReason = 'probe' | 'measure' | 'crash'
type TierChangeListener = (tier: DeviceQualityTier, reason: TierChangeReason) => void
const QUALITY_SETTLE_FRAMES = 4
interface RenderStatsDebugInfo — What `window.__bmDebug.getRenderStats()` reports: the renderer's counters after the last frame.
RenderStatsDebugInfo.visibleMeshes: number
RenderStatsDebugInfo.instancedMeshes: number
RenderStatsDebugInfo.drawCalls: number
RenderStatsDebugInfo.triangles: number
RenderStatsDebugInfo.geometries: number
RenderStatsDebugInfo.textures: number
interface QualityDebugInfo — What `?tierlog=1` and `window.__bmDebug.getQuality()` report.
QualityDebugInfo.tier: DeviceQualityTier
QualityDebugInfo.source: string
QualityDebugInfo.adapting: boolean
QualityDebugInfo.downgradesUsed: number
QualityDebugInfo.lastWindowFps: number | null
QualityDebugInfo.probeMsPerFrame: number | null
function getActiveQualityController(): QualityController | null
class QualityController
QualityController.constructor(private readonly engine: GameEngine, crashRescued: boolean)
QualityController.onTierChanged(cb: TierChangeListener): void
QualityController.noteDisturbance(reason: string): void
QualityController.resetSampling(): void
QualityController.runProbe(renderer: THREE.WebGLRenderer): Promise<void>
QualityController.recordFrame(nowMs: number, gapMs: number, busyMs: number, renderMs: number): void
QualityController.renderStats(): RenderStatsDebugInfo | null
QualityController.debugInfo(): QualityDebugInfo
