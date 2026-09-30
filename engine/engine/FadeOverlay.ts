// Fullscreen black `<div>` used for fade-to-black transitions during respawn
// and teleport. Extracted from PlayerController so the controller doesn't own
// DOM elements directly.
//
// Long holds (runtime level switches) can additionally show a progress line on
// the black via setProgress() — without it, a multi-second switch reads as a
// dead black screen. Short holds (respawn/teleport) never call it and are
// unchanged.

import { injectHudBaseStyles } from 'engine/hud/index.js';

/** The progress line's elements, built together on first setProgress(). */
interface ProgressLine {
	box: HTMLDivElement;
	label: HTMLSpanElement;
	percent: HTMLSpanElement;
	fill: HTMLDivElement;
}

export class FadeOverlay {
	private static readonly TRANSITION_MS = 250;

	private element: HTMLDivElement | null;
	/** Null until a caller reports progress — see buildProgressLine(). */
	private progress: ProgressLine | null = null;

	constructor() {
		const el = document.createElement('div');
		el.style.position = 'fixed';
		el.style.top = '0';
		el.style.left = '0';
		el.style.width = '100%';
		el.style.height = '100%';
		el.style.backgroundColor = 'black';
		el.style.opacity = '0';
		el.style.pointerEvents = 'none';
		el.style.transition = `opacity ${FadeOverlay.TRANSITION_MS / 1000}s ease-in-out`;
		el.style.zIndex = '9999';
		document.body.appendChild(el);
		this.element = el;
	}

	fadeOut(): Promise<void> {
		return this.fadeTo('1');
	}

	fadeIn(): Promise<void> {
		return this.fadeTo('0');
	}

	/** Start the CSS opacity transition and resolve when it has finished. */
	private fadeTo(opacity: string): Promise<void> {
		if (!this.element) return Promise.resolve();
		this.element.style.opacity = opacity;
		return new Promise((resolve) => setTimeout(resolve, FadeOverlay.TRANSITION_MS));
	}

	/**
	 * Show (or update) a progress line centered on the black overlay, or hide
	 * it with `null`. The bar reuses the shared `.hud-progress-bar` component
	 * so it matches the main screen; the element is built lazily, so overlays
	 * that never report progress (respawn/teleport fades) carry no extra DOM.
	 */
	setProgress(fraction: number | null, label?: string): void {
		if (!this.element) {
			return;
		}
		if (fraction === null) {
			if (this.progress) {
				this.progress.box.style.display = 'none';
				// Hiding the line always ends the busy state too — the unlock
				// path must never leave a shimmer armed for the next hold.
				this.progress.box.classList.remove('hud-progress-bar--busy');
			}
			return;
		}
		const progress = this.progress ?? this.buildProgressLine(this.element);
		progress.box.style.display = 'flex';
		const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
		progress.fill.style.setProperty('--hud-progress-value', `${percent}%`);
		progress.percent.textContent = `${percent}%`;
		if (label !== undefined) {
			progress.label.textContent = label;
		}
	}

	/**
	 * Toggle the busy shimmer on the progress line (compositor-driven, so it
	 * keeps moving while a load step blocks the main thread — see
	 * .hud-progress-bar--busy in hudBaseStyles). No-op before the progress
	 * box exists: a busy state without a visible line has nothing to shimmer,
	 * and building the box here would show an empty bar.
	 */
	setBusy(busy: boolean): void {
		this.progress?.box.classList.toggle('hud-progress-bar--busy', busy);
	}

	private buildProgressLine(parent: HTMLElement): ProgressLine {
		injectHudBaseStyles(); // idempotent; supplies .hud-progress-bar CSS

		const box = document.createElement('div');
		box.className = 'hud-progress-bar';
		// Center on the fade; the overlay div itself stays a plain full-screen
		// black (its opacity animates, and children inherit that fade).
		box.style.position = 'absolute';
		box.style.left = '50%';
		box.style.top = '50%';
		box.style.transform = 'translate(-50%, -50%)';
		box.style.width = 'min(70vw, 320px)';

		const labelRow = document.createElement('div');
		labelRow.className = 'hud-progress-bar__label';
		labelRow.style.display = 'flex';
		labelRow.style.justifyContent = 'space-between';
		labelRow.style.gap = '12px';
		const label = document.createElement('span');
		const percent = document.createElement('span');
		labelRow.appendChild(label);
		labelRow.appendChild(percent);

		const track = document.createElement('div');
		track.className = 'hud-progress-bar__track';
		const fill = document.createElement('div');
		fill.className = 'hud-progress-bar__fill';
		track.appendChild(fill);

		box.appendChild(labelRow);
		box.appendChild(track);
		parent.appendChild(box);
		this.progress = { box, label, percent, fill };
		return this.progress;
	}

	dispose(): void {
		this.element?.remove();
		this.element = null;
		this.progress = null;
	}
}
