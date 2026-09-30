/**
 * PushToTalk — one-call voice-input preset for game code.
 *
 * `engine.enablePushToTalk(onTranscript)` gives a game working voice input:
 * hold the key (desktop) or the TALK button (mobile) to record, release to
 * transcribe; the text arrives in the callback. Registers the desktop key and
 * the mobile button together via PlayerController.registerCustomAction (mobile
 * parity is automatic), shows a recording indicator, and reports failures as
 * HUD toasts — the game keeps running whatever goes wrong.
 *
 * For custom flows (an NPC dialog that opens the mic, a toggle instead of
 * hold-to-talk) drive `engine.getVoiceInput()` directly instead.
 */

import type { MobileButtonPosition } from 'engine/MobileButtonLayout.js';
import type { IGameHUD } from 'engine/IGameHUD.js';
import type { PlayerControllerLike } from 'types/game.js';
import { VoiceInput, VoiceInputError } from 'engine/VoiceInput.js';
import { VoiceIndicator } from 'engine/ui/VoiceIndicator.js';

/**
 * Options for the push-to-talk preset.
 * All fields are required; use DEFAULT_PUSH_TO_TALK_OPTIONS and spread overrides.
 */
export interface PushToTalkOptions {
  /** Action name registered on the player controller (key in `keys`). */
  action: string;
  /** Desktop hold-to-talk keys (KeyboardEvent.code values). */
  desktopKeys: string[];
  /** Mobile hold-to-talk button label. */
  mobileLabel: string;
  /** Mobile button theme role. */
  mobileRole: 'primary' | 'danger' | 'warning';
  /** Explicit mobile button position, or null for an automatic layout slot. */
  mobilePosition: MobileButtonPosition | null;
  /** Show the built-in recording indicator ("Listening…"). */
  indicator: boolean;
  /** ISO 639-1 language hint (e.g. 'en'), or null to auto-detect. */
  language: string | null;
  /** Recording auto-stops (and still transcribes) after this many milliseconds. */
  maxDurationMs: number;
  /** Holds shorter than this are discarded as accidental taps. */
  minDurationMs: number;
  /** Failure callback, or null for the default HUD toast. Never throws into game code. */
  onError: ((error: VoiceInputError) => void) | null;
}

export const DEFAULT_PUSH_TO_TALK_OPTIONS: PushToTalkOptions = {
  action: 'voiceTalk',
  desktopKeys: ['KeyV'],
  mobileLabel: 'TALK',
  mobileRole: 'primary',
  mobilePosition: null,
  indicator: true,
  language: null,
  maxDurationMs: 15_000,
  minDurationMs: 300,
  onError: null,
};

/**
 * The controller members push-to-talk needs. PlayerControllerLike doesn't
 * declare them; wiring checks structurally (same pattern as the engine's
 * declareMobileActions hook) and no-ops on controllers without them.
 */
interface PushToTalkController {
  registerCustomAction(def: {
    action: string;
    desktop?: { keys: string[] };
    mobile: {
      label: string;
      role?: 'primary' | 'danger' | 'warning';
      behavior: 'tap' | 'continuous';
      position?: MobileButtonPosition;
    };
  }): void;
  keys?: Record<string, boolean>;
}

const TOAST_BY_ERROR_CODE: Partial<Record<VoiceInputError['code'], string>> = {
  unsupported: "Voice input isn't available in this browser",
  'permission-denied': 'Microphone blocked — allow mic access to talk',
  unavailable: "Voice input isn't available right now",
  'rate-limited': 'Too many voice requests — try again in a moment',
  'transcription-failed': 'Voice input failed — try again',
};

export class PushToTalk {
  private voiceInput: VoiceInput;
  private onTranscript: ((text: string) => void) | null = null;
  private options: PushToTalkOptions = DEFAULT_PUSH_TO_TALK_OPTIONS;
  private controller: PushToTalkController | null = null;
  private hud: IGameHUD | null = null;
  private indicator: VoiceIndicator | null = null;
  private wasPressed = false;
  private pressStartedAt = 0;

  constructor(voiceInput: VoiceInput) {
    this.voiceInput = voiceInput;
  }

  /** Store the config from engine.enablePushToTalk. Wiring happens in wire(). */
  configure(onTranscript: (text: string) => void, options?: Partial<PushToTalkOptions>): void {
    this.onTranscript = onTranscript;
    this.options = { ...DEFAULT_PUSH_TO_TALK_OPTIONS, ...options };
  }

  isConfigured(): boolean {
    return this.onTranscript !== null;
  }

  /**
   * Bind the key + mobile button and create the indicator. Called by the engine
   * once the genre's player controller is registered (or immediately when
   * enablePushToTalk runs after load). No-op until configured; safe to call twice.
   */
  wire(playerController: PlayerControllerLike | null, hud: IGameHUD | null, container: HTMLElement): void {
    if (!this.isConfigured() || this.controller) return;
    this.hud = hud;
    if (!playerController || !('registerCustomAction' in playerController)) return;

    if (!this.voiceInput.isSupported()) {
      console.warn('[PushToTalk] Voice input not supported in this browser; the talk button is not registered');
      this.showError(new VoiceInputError('unsupported', 'Voice input is not supported in this browser/context'));
      return;
    }

    const controller = playerController as unknown as PushToTalkController;
    controller.registerCustomAction({
      action: this.options.action,
      desktop: { keys: this.options.desktopKeys },
      mobile: {
        label: this.options.mobileLabel,
        role: this.options.mobileRole,
        behavior: 'continuous',
        position: this.options.mobilePosition ?? undefined,
      },
    });
    this.controller = controller;

    if (this.options.indicator) {
      this.indicator = new VoiceIndicator(this.voiceInput, hud, container);
    }
  }

  /** Per-frame edge detection on the held action key/button (engine calls this from animate). */
  update(): void {
    if (!this.controller || !this.onTranscript) return;
    // Read `keys` through the controller each frame — the map object is
    // replaced by setControlsEnabled, so a cached reference goes stale.
    const pressed = this.controller.keys?.[this.options.action] === true;
    if (pressed === this.wasPressed) return;
    this.wasPressed = pressed;
    if (pressed) {
      this.onPress();
    } else {
      this.onRelease();
    }
  }

  /** Clear per-game state (config, wiring, indicator). Engine calls this from loadGame. */
  reset(): void {
    this.indicator?.dispose();
    this.indicator = null;
    this.controller = null;
    this.hud = null;
    this.onTranscript = null;
    this.options = DEFAULT_PUSH_TO_TALK_OPTIONS;
    this.wasPressed = false;
  }

  private onPress(): void {
    if (this.voiceInput.getState() !== 'idle') return;
    this.pressStartedAt = performance.now();
    this.voiceInput
      .startListening({ language: this.options.language, maxDurationMs: this.options.maxDurationMs })
      .catch((err) => this.handleError(err));
  }

  private onRelease(): void {
    const heldMs = performance.now() - this.pressStartedAt;
    if (this.voiceInput.isListening() && heldMs < this.options.minDurationMs) {
      this.voiceInput.cancelListening();
      return;
    }
    this.voiceInput
      .stopListening()
      .then((result) => {
        const text = result.text.trim();
        if (text) this.onTranscript?.(text);
      })
      .catch((err) => this.handleError(err));
  }

  private handleError(err: unknown): void {
    // A stop can race an auto-stop or an errored start; that's a non-event.
    if (err instanceof VoiceInputError && (err.code === 'not-listening' || err.code === 'already-listening')) return;
    const error = err instanceof VoiceInputError
      ? err
      : new VoiceInputError('transcription-failed', err instanceof Error ? err.message : String(err));
    if (this.options.onError) {
      this.options.onError(error);
      return;
    }
    this.showError(error);
  }

  private showError(error: VoiceInputError): void {
    console.warn(`[PushToTalk] ${error.code}: ${error.message}`);
    const toast = TOAST_BY_ERROR_CODE[error.code];
    if (toast) this.hud?.showToast(toast);
  }
}
