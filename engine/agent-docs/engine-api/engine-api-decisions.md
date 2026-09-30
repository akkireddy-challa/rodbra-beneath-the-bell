# engine-api-decisions

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/decisions/DecisionLoop.ts
interface DecisionReporter — A policy that also keeps counters and answer rows — `ModelDecisionPolicy`
DecisionReporter.readonly stats: DecisionStatsRecorder
DecisionReporter.snapshots(): readonly DecisionSnapshot[]
DecisionReporter.resetCounters(): void
interface DecisionLoopOptions
DecisionLoopOptions.tickMs: number
DecisionLoopOptions.enabled: boolean
const DEFAULT_DECISION_LOOP_OPTIONS: DecisionLoopOptions
const MIN_TICK_MS = 250
interface DecisionLoopConfig<V, R>
DecisionLoopConfig.perceive(): V
DecisionLoopConfig.policy: DecisionPolicy<V, R>
DecisionLoopConfig.reporter: DecisionReporter | null
DecisionLoopConfig.applyResult(view: V, result: R): void
interface DecisionLoopStats
DecisionLoopStats.activePolicy: string
DecisionLoopStats.skippedTicks: number
DecisionLoopStats.inFlight: boolean
class DecisionLoop<V, R>
DecisionLoop.constructor(private readonly config: DecisionLoopConfig<V, R>)
DecisionLoop.update(deltaTime: number): void
DecisionLoop.setPolicy(policy: DecisionPolicy<V, R>, reporter: DecisionReporter | null): void
DecisionLoop.setEnabled(enabled: boolean): void
DecisionLoop.stats(): DecisionLoopStats
DecisionLoop.snapshots(): readonly DecisionSnapshot[]
DecisionLoop.resetCounters(): void
DecisionLoop.dispose(): void

## engine/decisions/DecisionOverlay.ts
interface DecisionOverlayOptions
DecisionOverlayOptions.anchor: HUDAnchor
DecisionOverlayOptions.visible: boolean
DecisionOverlayOptions.refreshS: number
const DEFAULT_DECISION_OVERLAY_OPTIONS: DecisionOverlayOptions
interface DecisionReadout — What the panel reads. `DecisionLoop` satisfies it whatever its view and result
DecisionReadout.snapshots(): readonly DecisionSnapshot[]
DecisionReadout.stats(): DecisionLoopStats
function decisionOverlayRequested(): boolean
class DecisionOverlay
DecisionOverlay.constructor(private readonly hud: IGameHUD, private readonly loop: DecisionReadout, options: DecisionOverlayOptions)
DecisionOverlay.setFilter(filter: DecisionOverlayOptions['filter']): void
DecisionOverlay.setVisible(visible: boolean): void
DecisionOverlay.update(deltaTime: number): void
DecisionOverlay.dispose(): void

## engine/decisions/DecisionOverlayMarkup.ts
interface DecisionPanelOptions
DecisionPanelOptions.title: string
DecisionPanelOptions.maxQuestions: number
DecisionPanelOptions.snapshotTtlMs: number
DecisionPanelOptions.compact: boolean
DecisionPanelOptions.filter: ((snapshot: DecisionSnapshot) => boolean) | null
const DEFAULT_DECISION_PANEL_OPTIONS: DecisionPanelOptions
const DECISION_PANEL_CSS = ` min-width: 300px; max-width: 400px; padding: 12px 14px; ba
const DECISION_PANEL_CSS_COMPACT = ` max-width: 60vw; padding: 8px 10px; background: ${BM.surfa
function escapeHtml(text: string): string
function visibleSnapshots(snapshots: readonly DecisionSnapshot[], now: number, options: DecisionPanelOptions): DecisionSnapshot[]
function renderDecisionPanel(snapshots: readonly DecisionSnapshot[], stats: DecisionLoopStats, now: number, options: DecisionPanelOptions): string

## engine/decisions/DecisionPolicy.ts
interface DecisionService — The structural slice of `AIService` this namespace needs. Depending on the type
DecisionService.decide<Q extends Record<string, DecisionQuestion>>( state: unknown, questions: Q, options?: DecisionOptions, ): Promise<DecisionsResult<Q>>
interface DecisionPolicy<V, R> — `V` is what the game perceived this tick, `R` is what it will apply. A policy
DecisionPolicy.readonly name: string
DecisionPolicy.decide(view: V): Promise<R>
interface DecisionAsk<Q extends Record<string, DecisionQuestion>> — The one batched request a tick sends.
DecisionAsk.state: unknown
DecisionAsk.questions: Q
interface DecisionRoundTrip — What the round trip reported, handed to `apply` so a game can log or show it.
DecisionRoundTrip.model: string
DecisionRoundTrip.latencyMs: number
DecisionRoundTrip.inputTokens: number
DecisionRoundTrip.costUsd: number
DecisionRoundTrip.questionCount: number
interface DecisionPolicyTuning — Tunables only — non-generic, so the `DEFAULT_*` const below is a plain value.
DecisionPolicyTuning.timeoutMs: number
DecisionPolicyTuning.sessionId: string
DecisionPolicyTuning.latencySamples: number
DecisionPolicyTuning.maxQuestions: number
const DEFAULT_DECISION_POLICY_TUNING: DecisionPolicyTuning
interface ModelPolicyOptions<V, R, Q extends Record<string, DecisionQuestion>>
ModelPolicyOptions.name: string
ModelPolicyOptions.ask(view: V): DecisionAsk<Q> | null
ModelPolicyOptions.apply(view: V, answers: DecisionAnswers<Q>, trip: DecisionRoundTrip): R
ModelPolicyOptions.resolveLocally(view: V): R
ModelPolicyOptions.describe: ((view: V, answers: DecisionAnswers<Q>) => DecisionSnapshot[]) | null
class ModelDecisionPolicy<V, R, Q extends Record<string, DecisionQuestion>> implements DecisionPolicy<V, R>
ModelDecisionPolicy.name: string
ModelDecisionPolicy.stats: DecisionStatsRecorder
ModelDecisionPolicy.constructor(private readonly ai: DecisionService, private readonly options: ModelPolicyOptions<V, R, Q>)
ModelDecisionPolicy.decide(view: V): Promise<R>
ModelDecisionPolicy.snapshots(): readonly DecisionSnapshot[]
ModelDecisionPolicy.resetCounters(): void

## engine/decisions/DecisionSnapshot.ts
interface DecisionOptionView
DecisionOptionView.key: string
DecisionOptionView.label: string
DecisionOptionView.probability: number
DecisionOptionView.chosen: boolean
interface DecisionSnapshot
DecisionSnapshot.id: string
DecisionSnapshot.question: string
DecisionSnapshot.options: DecisionOptionView[]
DecisionSnapshot.confidence: number
DecisionSnapshot.at: number
function snapshotFromChoice(id: string, question: string, answer: ChoiceAnswer, labels: Record<string, string>, at: number): DecisionSnapshot
function snapshotFromScore(id: string, question: string, answer: ScoreAnswer, at: number): DecisionSnapshot
function snapshotFromNoul(id: string, question: string, answer: NoulAnswer, at: number): DecisionSnapshot

## engine/decisions/DecisionStats.ts
interface DecisionStats — Raw counters. `last*` describe the most recent round trip, the rest accumulate.
DecisionStats.requests: number
DecisionStats.failures: number
DecisionStats.consecutiveFailures: number
DecisionStats.lastLatencyMs: number
DecisionStats.lastModel: string
DecisionStats.lastInputTokens: number
DecisionStats.lastQuestionCount: number
DecisionStats.totalCostUsd: number
DecisionStats.latenciesMs: number[]
DecisionStats.confidenceSum: number
DecisionStats.confidenceCount: number
interface DecisionStatsSummary — Flat and JSON-safe: what an overlay, a metrics panel or a logged row reads.
DecisionStatsSummary.requests: number
DecisionStatsSummary.failures: number
DecisionStatsSummary.lastLatencyMs: number
DecisionStatsSummary.p50LatencyMs: number
DecisionStatsSummary.p95LatencyMs: number
DecisionStatsSummary.lastModel: string
DecisionStatsSummary.lastInputTokens: number
DecisionStatsSummary.lastQuestionCount: number
DecisionStatsSummary.costUsd: number
DecisionStatsSummary.meanConfidence: number
function answerConfidence(answer: DecisionAnswer): number | null
class DecisionStatsRecorder
DecisionStatsRecorder.stats: DecisionStats
DecisionStatsRecorder.constructor(private readonly latencySamples: number)
DecisionStatsRecorder.recordRequest(questionCount: number): void
DecisionStatsRecorder.recordSuccess(result: { model: string; usage: DecisionsUsage; latencyMs: number }, answers: Record<string, DecisionAnswer>): void
DecisionStatsRecorder.recordFailure(): void
DecisionStatsRecorder.resetCounters(): void
DecisionStatsRecorder.summary(): DecisionStatsSummary

## engine/decisions/DegradingPolicy.ts
interface DegradingOptions
DegradingOptions.failuresBeforeFallback: number
DegradingOptions.fallbackSeconds: number
DegradingOptions.now(): number
const DEFAULT_DEGRADING_OPTIONS: DegradingOptions
class DegradingPolicy<V, R> implements DecisionPolicy<V, R>
DegradingPolicy.constructor(private readonly primary: DecisionPolicy<V, R>, private readonly fallback: DecisionPolicy<V, R>, private readonly options: DegradingOptions)
DegradingPolicy.get name(): string
DegradingPolicy.decide(view: V): Promise<R>
