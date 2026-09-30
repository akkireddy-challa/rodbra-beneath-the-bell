/**
 * Public surface of the runtime decision system — a decision model (TypeSafe's
 * Jev, reached through `AIService.decide`) driving game behaviour on a tick.
 *
 * Games import from this barrel rather than reaching into individual modules.
 * See `agent-docs/decision-ai.md` for when to use it and how to shape a question.
 */

export {
    type DecisionService,
    type DecisionPolicy,
    type DecisionAsk,
    type DecisionRoundTrip,
    type DecisionPolicyTuning,
    type ModelPolicyOptions,
    DEFAULT_DECISION_POLICY_TUNING,
    ModelDecisionPolicy,
} from 'engine/decisions/DecisionPolicy.js';

export {
    type DegradingOptions,
    DEFAULT_DEGRADING_OPTIONS,
    DegradingPolicy,
} from 'engine/decisions/DegradingPolicy.js';

export {
    RuntimeAIBackoffError,
    DEFAULT_BACKOFF_MS,
    isBackoffStatus,
    readRetryAfterMs,
} from 'engine/RuntimeAIErrors.js';

export {
    type DecisionReporter,
    type DecisionLoopOptions,
    type DecisionLoopConfig,
    type DecisionLoopStats,
    DEFAULT_DECISION_LOOP_OPTIONS,
    MIN_TICK_MS,
    DecisionLoop,
} from 'engine/decisions/DecisionLoop.js';

export {
    type DecisionOptionView,
    type DecisionSnapshot,
    snapshotFromChoice,
    snapshotFromScore,
    snapshotFromNoul,
} from 'engine/decisions/DecisionSnapshot.js';

export {
    type DecisionPanelOptions,
    DEFAULT_DECISION_PANEL_OPTIONS,
    DECISION_PANEL_CSS,
    DECISION_PANEL_CSS_COMPACT,
    escapeHtml,
    visibleSnapshots,
    renderDecisionPanel,
} from 'engine/decisions/DecisionOverlayMarkup.js';

export {
    type DecisionReadout,
    type DecisionOverlayOptions,
    DEFAULT_DECISION_OVERLAY_OPTIONS,
    DecisionOverlay,
    decisionOverlayRequested,
} from 'engine/decisions/DecisionOverlay.js';

export {
    type DecisionStats,
    type DecisionStatsSummary,
    DecisionStatsRecorder,
    answerConfidence,
} from 'engine/decisions/DecisionStats.js';
