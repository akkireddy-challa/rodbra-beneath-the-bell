# engine-api-recording

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/recording/GameEventLog.ts
type TimelinePosition = [number, number, number]
interface GameEventInput — Input accepted by logEvent — position may be a THREE.Vector3-like object.
GameEventInput.type: string
GameEventInput.intensity?: number
GameEventInput.position?: { x: number; y: number; z: number } | TimelinePosition
GameEventInput.actor?: string
GameEventInput.data?: Record<string, unknown>
interface TimelineGameEvent
TimelineGameEvent.frame: number
TimelineGameEvent.type: string
TimelineGameEvent.intensity: number
TimelineGameEvent.position?: TimelinePosition
TimelineGameEvent.actor?: string
TimelineGameEvent.data?: Record<string, unknown>
interface SynthSoundRecipeLayer
SynthSoundRecipeLayer.wave: 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise'
SynthSoundRecipeLayer.freq?: number | [number, number]
SynthSoundRecipeLayer.gain?: number | [number, number]
interface SynthSoundRecipe — Deterministic description of a synthesized SFX so it can be re-rendered offline.
SynthSoundRecipe.dur: number
SynthSoundRecipe.layers: SynthSoundRecipeLayer[]
type TimelineSoundEvent = | { frame: number; kind: 'asset'; assetId: string; url: string; volume?: number } | { frame: number; kind: 'synth'; name: string; recipe?: SynthSoundRecipe }
interface TimelineMusicEvent
TimelineMusicEvent.frame: number
TimelineMusicEvent.action: 'play' | 'stop'
TimelineMusicEvent.assetId?: string
TimelineMusicEvent.url?: string
TimelineMusicEvent.volume?: number
TimelineMusicEvent.loop?: boolean
TimelineMusicEvent.fadeIn?: number
TimelineMusicEvent.fadeOut?: number
type TimelineHudOp = | { frame: number; op: 'create'; id: string; elType: HudElementKind; params: Record<string, unknown> } | { frame: number; op: 'update'; id: string; text?: string; icon?: string; percent?: number } | { frame: number; op: 'custom-html'; id: string; html: string; css?: string } | { frame: number; op: 'timer'; id: string; action: 'start' | 'pause' | 'reset'; seconds?: number } | { frame: number; op: 'show' | 'hide' | 'remove'; id: string } | { frame: number; op: 'health'; current: number; max: number } | { frame: number; op: 'health-visible'; visible: boolean; width?: number } | { frame: number; op: 'toast'; message: string; variant?: string; durationMs?: number; anchor?: string } | { frame: number; op: 'hud-visible'; visible: boolean } | { frame: number; op: 'theme'; theme: unknown } // A game-authored head stylesheet, captured so the replay harness can style // custom-element markup. `id` is the <style> element's own id; last write // per id wins on replay, and an empty `css` is a tombstone meaning the game // removed that sheet (without it a skin swapped by removal replays with // both skins applied at once). | { frame: number; op: 'stylesheet'; id: string; css: string }
type HudElementKind = 'counter' | 'progress' | 'icon-text' | 'timer' | 'custom'
type HudOpInput = TimelineHudOp extends infer T ? T extends { frame: number } ? Omit<T, 'frame'> : never : never
interface TimelineSession
TimelineSession.events: TimelineGameEvent[]
TimelineSession.sounds: TimelineSoundEvent[]
TimelineSession.music: TimelineMusicEvent[]
TimelineSession.hud: TimelineHudOp[]
const MAX_HUD_BYTES_PER_SESSION = 32 * 1024 * 1024
type EventLogOwner = 'recorder' | 'eventlog'
class GameEventLog
GameEventLog.isActive(): boolean
GameEventLog.getOwner(): EventLogOwner | null
GameEventLog.startSession(frameProvider: () => number, owner: EventLogOwner): void
GameEventLog.getSessionSerial(): number
GameEventLog.endSession(owner: EventLogOwner): TimelineSession | null
GameEventLog.getSnapshot(): TimelineSession
GameEventLog.logEvent(event: GameEventInput): void
GameEventLog.logAssetSound(assetId: string, url: string, volume?: number): void
GameEventLog.logSynthSound(name: string, recipe?: SynthSoundRecipe): void
GameEventLog.logMusic(action: 'play' | 'stop', info: Omit<TimelineMusicEvent, 'frame' | 'action'> = {}): void
GameEventLog.logHud(op: HudOpInput): void
function getGameEventLog(): GameEventLog
