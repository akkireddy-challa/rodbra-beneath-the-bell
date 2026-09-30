import type { DesktopControls } from 'engine/DesktopControls.js';
import type { MobileControls } from 'engine/MobileControls.js';
import type { GamepadControls } from 'engine/GamepadControls.js';

export type SuppressibleAction = 'action' | 'secondaryAction' | 'interact' | 'ascend' | 'descend' | 'exit';

const ALL_ACTIONS: SuppressibleAction[] = ['action', 'secondaryAction', 'interact', 'ascend', 'descend', 'exit'];

// Maps an action name to per-channel "Pressed" flag clearers on each input source.
// Called every frame for any action whose suppression deadline is still in the future.
export class ActionSuppressionManager {
	private suppressUntil: Map<string, number> = new Map();

	// Suppress the given action(s) for `seconds`. While suppressed, the engine
	// forces `keys[<action>]` AND the mirrored `*Pressed` flags on each input
	// source to false on every frame — so a single physical press cannot leak
	// into multiple subsystems after a transition (teleport, dialog close, etc.).
	suppressFor(seconds: number, actions?: SuppressibleAction[]): void {
		const list = actions ?? ALL_ACTIONS;
		const deadline = performance.now() + seconds * 1000;
		for (const name of list) {
			this.suppressUntil.set(name, deadline);
		}
	}

	// Apply currently-active suppressions to the merged `keys` object and reset
	// the per-channel `*Pressed` flags on each input source. Expired entries are
	// pruned lazily.
	apply(
		keys: Record<string, boolean>,
		desktopControls: DesktopControls,
		mobileControls: MobileControls,
		gamepadControls: GamepadControls,
	): void {
		if (this.suppressUntil.size === 0) return;
		const now = performance.now();
		for (const [name, deadline] of this.suppressUntil) {
			if (now >= deadline) {
				this.suppressUntil.delete(name);
				continue;
			}
			keys[name] = false;
			switch (name as SuppressibleAction) {
				case 'action':
					desktopControls.actionPressed = false;
					mobileControls.resetActionPressed();
					gamepadControls.resetActionPressed();
					break;
				case 'secondaryAction':
					desktopControls.secondaryActionPressed = false;
					mobileControls.resetSecondaryActionPressed();
					gamepadControls.resetSecondaryActionPressed();
					break;
				case 'interact':
					desktopControls.interactPressed = false;
					mobileControls.resetInteractPressed();
					gamepadControls.resetInteractPressed();
					break;
				case 'ascend':
					desktopControls.ascendPressed = false;
					mobileControls.resetAscendPressed();
					gamepadControls.resetAscendPressed();
					break;
				case 'descend':
					desktopControls.descendPressed = false;
					mobileControls.resetDescendPressed();
					gamepadControls.resetDescendPressed();
					break;
				case 'exit':
					desktopControls.exitPressed = false;
					mobileControls.resetExitPressed();
					gamepadControls.resetExitPressed();
					break;
			}
		}
	}
}
