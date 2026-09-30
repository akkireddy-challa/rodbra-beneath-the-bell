/**
 * PointerLockManager - Handles mouse pointer lock for PC gameplay
 * 
 * Features:
 * - Locks mouse cursor during gameplay for smooth camera control
 * - Shows re-engagement overlay when pointer lock is released
 * - Handles ESC key unlock (browser default) and Windows-key (Meta) unlock
 * - Desktop-only - automatically disabled on mobile devices
 */

import { t } from 'engine/i18n/index.js';
import { isMobileRuntime } from 'engine/isMobileRuntime.js';
import { createNamedIcon } from 'engine/hud/index.js';

export type PointerLockChangeListener = (isLocked: boolean) => void;

// Pointer-lock rejections the browser raises during ordinary play - a re-lock racing a
// pending exit, an unfocused document, or a re-lock inside Chrome's throttle window.
// Chrome words some of these as "report this bug to chromium", but none indicate a game
// defect, so they must not reach the captured-error stream the Creator turns into a fix prompt.
const BENIGN_LOCK_REJECTIONS = [
	'exited the lock',
	'report this bug to chromium',
	'not focused',
	'document is not focused',
	'too quickly',
	'a user gesture is required',
];

function isBenignLockRejection(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	const lower = message.toLowerCase();
	return BENIGN_LOCK_REJECTIONS.some(benign => lower.includes(benign));
}

export class PointerLockManager {
	private element: HTMLElement;
	private overlay: HTMLDivElement | null = null;
	private isLocked: boolean = false;
	private isSupported: boolean = false;
	private isMobile: boolean = false;
	private isMac: boolean = false;
	private listeners: PointerLockChangeListener[] = [];
	private lockRequestPending: boolean = false;
	private retryTimers: ReturnType<typeof setTimeout>[] = [];
	private readonly claimClickPrompt: () => boolean;

	// Editor mode - when true, pointer lock is disabled and overlay is hidden
	// Used for editor tabs (Scene, Voxels, etc.) where traditional mouse control is needed
	private editorMode: boolean = false;
	
	// Interactive UI mode - when true, overlay is hidden to allow clicking UI buttons
	// Used when game shows interactive elements (Play Again buttons, dialogs, etc.)
	private interactiveUIMode: boolean = false;
	
	// Free mouse mode - when true, pointer lock is disabled for the entire game
	// Used for games that need mouse during gameplay (point-and-click, strategy, etc.)
	private freeMouseMode: boolean = false;
	
	// Bound event handlers for cleanup
	private boundOnPointerLockChange: () => void;
	private boundOnPointerLockError: () => void;
	private boundOnKeyDown: (e: KeyboardEvent) => void;
	private boundOnOverlayClick: (e: MouseEvent) => void;
	private boundOnOverlayMouseDown: (e: MouseEvent) => void;
	
	/**
	 * @param claimClickPrompt Asked every time "Click to play" is about to show. Returning true
	 * means the caller put up its own prompt (the pause card), and the overlay stays hidden.
	 */
	constructor(element: HTMLElement, claimClickPrompt: () => boolean) {
		this.element = element;
		this.claimClickPrompt = claimClickPrompt;
		
		// Make element focusable for keyboard events (required after pointer lock re-acquisition)
		if (!element.hasAttribute('tabindex')) {
			element.setAttribute('tabindex', '-1');
		}
		
		// Check if mobile device
		this.isMobile = isMobileRuntime();
		
		// Check if Mac (for platform-specific key handling)
		this.isMac = this.checkIsMac();
		
		// Check if pointer lock is supported (and not mobile)
		this.isSupported = !this.isMobile && 'pointerLockElement' in document;
		
		// Bind event handlers
		this.boundOnPointerLockChange = this.onPointerLockChange.bind(this);
		this.boundOnPointerLockError = this.onPointerLockError.bind(this);
		this.boundOnKeyDown = this.onKeyDown.bind(this);
		this.boundOnOverlayClick = this.onOverlayClick.bind(this);
		this.boundOnOverlayMouseDown = this.onOverlayMouseDown.bind(this);
		
		if (this.isSupported) {
			this.setupEventListeners();
			this.createOverlay();
		}
		
		console.log(`🔒 PointerLockManager: Initialized (supported: ${this.isSupported}, mobile: ${this.isMobile})`);
	}
	
	/**
	 * Check if this is a Mac device
	 * Uses multiple detection methods for cross-browser compatibility
	 */
	private checkIsMac(): boolean {
		// Modern approach: User Agent Client Hints API (Chrome 90+, Edge 90+, Opera 76+)
		const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
		if (nav.userAgentData?.platform) {
			return nav.userAgentData.platform.toLowerCase() === 'macos';
		}
		
		// Fallback: navigator.platform (works in all browsers, though deprecated)
		if (navigator.platform) {
			return /mac/i.test(navigator.platform);
		}
		
		// Last resort: userAgent string
		return /macintosh|mac os x/i.test(navigator.userAgent);
	}
	
	/**
	 * Set up pointer lock event listeners
	 */
	private setupEventListeners(): void {
		document.addEventListener('pointerlockchange', this.boundOnPointerLockChange);
		document.addEventListener('pointerlockerror', this.boundOnPointerLockError);
		document.addEventListener('keydown', this.boundOnKeyDown);
	}
	
	/**
	 * Create the re-engagement overlay. Visual styling lives in hud-base.css under
	 * .hud-pointer-lock-overlay — theme tokens (color, font, radius, glow) recolor
	 * the "Click to play" pill alongside the rest of the HUD.
	 */
	private createOverlay(): void {
		this.overlay = document.createElement('div');
		this.overlay.id = 'pointer-lock-overlay';
		this.overlay.className = 'hud-pointer-lock-overlay';

		const inner = document.createElement('div');
		inner.className = 'hud-pointer-lock-overlay__inner';

		const mouseIcon = document.createElement('div');
		mouseIcon.className = 'hud-pointer-lock-overlay__icon';
		// createNamedIcon reads from the theme registry so a horror-themed mouse
		// SVG (if the theme provides one) replaces the default outlined mouse.
		mouseIcon.appendChild(createNamedIcon('mouse'));

		const mainMessage = document.createElement('div');
		mainMessage.className = 'hud-pointer-lock-overlay__message';
		mainMessage.textContent = t('game.pointerLock.clickToPlay') || 'Click to play';

		inner.appendChild(mouseIcon);
		inner.appendChild(mainMessage);
		this.overlay.appendChild(inner);

		// Add mousedown handler to prevent the click from triggering shooting
		this.overlay.addEventListener('mousedown', this.boundOnOverlayMouseDown, true);
		// Add click handler to re-lock (use capture to ensure we catch all clicks)
		this.overlay.addEventListener('click', this.boundOnOverlayClick, true);

		document.body.appendChild(this.overlay);
	}
	
	/**
	 * Handle overlay mousedown - stop propagation to prevent shooting
	 */
	private onOverlayMouseDown(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
	}

	/**
	 * Handle overlay click - request pointer lock
	 */
	private onOverlayClick(e: MouseEvent): void {
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		this.requestLockWithRetry();
	}

	/**
	 * Request the lock from a click, riding out the browser's re-lock cooldown.
	 *
	 * Chrome refuses a lock for about a second after the player left it with ESC, so a
	 * single request from a quick click fails silently. Hides the overlay at once and
	 * retries while the click's user activation is still live; if every retry is refused,
	 * "Click to play" comes back and listeners hear `isLocked = false`.
	 */
	public requestLockWithRetry(): void {
		this.cancelLockRequest();
		// Nothing to wait for — and a pending flag left up would suppress the next prompt.
		if (!this.isSupported || this.isLocked || this.editorMode || this.freeMouseMode) return;

		// Hide overlay immediately on click (don't wait for pointer lock to be acquired)
		if (this.overlay) {
			delete this.overlay.dataset.visible;
		}

		// Set pending flag to prevent overlay from flashing back
		this.lockRequestPending = true;

		this.requestLock();

		const retryDelays = [100, 300, 600, 1000];
		retryDelays.forEach(delay => {
			this.retryTimers.push(setTimeout(() => {
				if (!this.isLocked && this.lockRequestPending) {
					this.requestLock();
				}
			}, delay));
		});

		// Clear pending flag after all retries (show overlay if still not locked)
		this.retryTimers.push(setTimeout(() => {
			this.retryTimers = [];
			this.lockRequestPending = false;
			this.showOverlay();
			// A refused first lock never fires pointerlockchange, so nobody would hear
			// that the game is now sitting behind "Click to play". Tell listeners
			// (isLocked = false) so gameplay can pause instead of running unseen.
			if (!this.isLocked && this.isOverlayVisible()) {
				this.notifyListeners();
			}
		}, 1500));
	}

	/**
	 * Drop a pending `requestLockWithRetry` — its retries and its "Click to play" fallback —
	 * for when something else (the pause card) takes the screen while the lock is pending.
	 */
	public cancelLockRequest(): void {
		this.retryTimers.forEach(timer => clearTimeout(timer));
		this.retryTimers = [];
		this.lockRequestPending = false;
	}
	
	/**
	 * Handle pointer lock state changes
	 */
	private onPointerLockChange(): void {
		const wasLocked = this.isLocked;
		this.isLocked = document.pointerLockElement === this.element;
		
		if (wasLocked !== this.isLocked) {
			console.log(`🔒 PointerLockManager: Pointer lock ${this.isLocked ? 'acquired' : 'released'}`);
			
			// Clear pending flag when lock is acquired
			if (this.isLocked) {
				this.lockRequestPending = false;
				
				// Ensure the document/window has focus for keyboard events
				// This is critical when re-acquiring pointer lock after ESC
				// The overlay click might not properly restore keyboard focus
				window.focus();
				if (this.element.focus) {
					this.element.focus();
				}
			}
			
			// Lost the lock: ask for a click (showOverlay skips the modes that own the mouse).
			// Not while a lock request is still retrying — it may yet land.
			if (this.isLocked) {
				this.hideOverlay();
			} else if (!this.lockRequestPending) {
				this.showOverlay();
			}
			
			// Notify listeners
			this.notifyListeners();
		}
	}
	
	/**
	 * Handle pointer lock errors
	 *
	 * Note: We don't clear lockRequestPending here because the retry mechanism
	 * in onOverlayClick will continue trying. The 1500ms timeout handles cleanup
	 * if all retries fail. This prevents the double-click issue after ESC.
	 *
	 * This error is often triggered by rapid ESC presses or focus changes,
	 * which is expected behavior - we log at warn level, not error.
	 */
	private onPointerLockError(): void {
		console.warn('🔒 PointerLockManager: Pointer lock error (retries may continue)');
		this.isLocked = false;
		// Don't clear lockRequestPending - let retries continue
		// Don't show overlay - let the retry timeout handle it
	}
	
	/**
	 * Handle key presses (modifier keys to unlock)
	 * 
	 * Platform-specific behavior:
	 * - Mac: Only ESC releases pointer lock (browser handles this automatically)
	 * - Windows: Windows key (Meta) releases pointer lock
	 */
	private onKeyDown(e: KeyboardEvent): void {
		// On Mac, only ESC should release pointer lock (browser handles this automatically)
		if (this.isMac) {
			return;
		}
		
		// On Windows, the Windows key (Meta) should release pointer lock
		if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
			if (this.isLocked) {
				this.exitLock();
			}
		}
	}
	
	/**
	 * Request pointer lock
	 * Must be called from a user gesture (click)
	 */
	public requestLock(): void {
		if (!this.isSupported) {
			console.log('🔒 PointerLockManager: Pointer lock not supported');
			return;
		}

		// Don't lock in editor mode or free mouse mode
		if (this.editorMode || this.freeMouseMode) {
			return;
		}

		if (this.isLocked) {
			return;
		}

		try {
			// requestPointerLock returns a Promise - handle rejection to prevent
			// "Unhandled Promise Rejection" errors when user exits lock before request completes
			const lockPromise = this.element.requestPointerLock();
			if (lockPromise && typeof lockPromise.catch === 'function') {
				lockPromise.catch((error: Error) => {
					// Expected during rapid ESC presses, clicking in and out of the window, or a
					// re-lock inside the browser's throttle window - warn so it stays visible in
					// devtools without being captured as a game error
					if (isBenignLockRejection(error)) {
						console.warn('🔒 PointerLockManager: Pointer lock request ignored by browser:', error);
						return;
					}
					console.error('🔒 PointerLockManager: Failed to request pointer lock:', error);
				});
			}
		} catch (error) {
			if (isBenignLockRejection(error)) {
				console.warn('🔒 PointerLockManager: Pointer lock request ignored by browser:', error);
				return;
			}
			console.error('🔒 PointerLockManager: Failed to request pointer lock:', error);
		}
	}
	
	/**
	 * Exit pointer lock
	 */
	public exitLock(): void {
		if (!this.isSupported || !this.isLocked) {
			return;
		}
		
		try {
			document.exitPointerLock();
		} catch (error) {
			console.error('🔒 PointerLockManager: Failed to exit pointer lock:', error);
		}
	}
	
	/**
	 * Check if pointer lock is currently active
	 */
	public getIsLocked(): boolean {
		return this.isLocked;
	}
	
	/**
	 * Check if pointer lock is supported on this device
	 */
	public getIsSupported(): boolean {
		return this.isSupported;
	}
	
	/**
	 * Check if this is a mobile device
	 */
	public getIsMobile(): boolean {
		return this.isMobile;
	}
	
	/**
	 * Add a listener for pointer lock state changes
	 */
	public addListener(listener: PointerLockChangeListener): void {
		this.listeners.push(listener);
	}
	
	/**
	 * Remove a listener
	 */
	public removeListener(listener: PointerLockChangeListener): void {
		const index = this.listeners.indexOf(listener);
		if (index !== -1) {
			this.listeners.splice(index, 1);
		}
	}
	
	/**
	 * Notify all listeners of state change
	 */
	private notifyListeners(): void {
		this.listeners.forEach(listener => {
			try {
				listener(this.isLocked);
			} catch (error) {
				console.error('🔒 PointerLockManager: Error in listener:', error);
			}
		});
	}
	
	/**
	 * Show the overlay (called when game starts but pointer not locked)
	 */
	public showOverlay(): void {
		// Don't show overlay in editor mode, free mouse mode, or interactive UI mode
		// (interactive UI mode means a cursor-driven screen asked for the mouse - covering
		// it with the overlay would swallow every click with no way to recover)
		if (this.editorMode || this.freeMouseMode || this.interactiveUIMode) {
			return;
		}
		if (!this.overlay || !this.isSupported || this.isLocked) return;
		// "Click to play" is the start prompt; once the player has played, the owner's
		// pause card asks for the click instead.
		if (this.claimClickPrompt()) return;
		this.overlay.dataset.visible = 'true';
	}
	
	/** True while the "Click to play" re-engagement overlay is on screen. */
	public isOverlayVisible(): boolean {
		return this.overlay?.dataset.visible === 'true';
	}

	/**
	 * Hide the overlay
	 */
	public hideOverlay(): void {
		if (this.overlay) {
			delete this.overlay.dataset.visible;
		}
	}
	
	/**
	 * Enable editor mode - disables pointer lock and hides overlay
	 * Used for editor tabs (Scene, Voxels, etc.) where traditional mouse control is needed
	 */
	public setEditorMode(enabled: boolean): void {
		this.editorMode = enabled;
		
		if (enabled) {
			// Exit pointer lock if currently locked
			if (this.isLocked) {
				this.exitLock();
			}
			// Hide overlay
			this.hideOverlay();
			console.log('🔒 PointerLockManager: Editor mode enabled');
		} else {
			console.log('🔒 PointerLockManager: Editor mode disabled');
		}
	}
	
	/**
	 * Check if editor mode is active
	 */
	public getEditorMode(): boolean {
		return this.editorMode;
	}
	
	/**
	 * Enable interactive UI mode - hides overlay to allow clicking game UI elements
	 * Used when game shows interactive elements (Play Again buttons, dialogs, etc.)
	 * Unlike editor mode, this doesn't disable pointer lock entirely - just hides overlay
	 */
	public setInteractiveUIMode(enabled: boolean): void {
		this.interactiveUIMode = enabled;
		
		if (enabled) {
			// Hide overlay when interactive UI is shown
			this.hideOverlay();
		} else {
			// When interactive UI is dismissed and pointer is not locked, ask for a click —
			// unless a lock request made for that dismissal is still retrying.
			if (!this.isLocked && !this.editorMode && !this.freeMouseMode && !this.lockRequestPending) {
				this.showOverlay();
			}
		}
	}
	
	/**
	 * Check if interactive UI mode is active
	 */
	public getInteractiveUIMode(): boolean {
		return this.interactiveUIMode;
	}
	
	/**
	 * Enable free mouse mode - disables pointer lock for the entire game
	 * Used for games that need mouse during gameplay (point-and-click, strategy, etc.)
	 * Set via worldProfileData.useFreeMouse in world.json
	 */
	public setFreeMouseMode(enabled: boolean): void {
		this.freeMouseMode = enabled;
		
		if (enabled) {
			if (this.isLocked) {
				this.exitLock();
			}
			this.hideOverlay();
		}
	}
	
	public getFreeMouseMode(): boolean {
		return this.freeMouseMode;
	}
	
	/**
	 * Clean up event listeners and remove overlay
	 */
	public dispose(): void {
		this.cancelLockRequest();

		// Remove event listeners
		document.removeEventListener('pointerlockchange', this.boundOnPointerLockChange);
		document.removeEventListener('pointerlockerror', this.boundOnPointerLockError);
		document.removeEventListener('keydown', this.boundOnKeyDown);
		
		// Remove overlay
		if (this.overlay) {
			this.overlay.removeEventListener('mousedown', this.boundOnOverlayMouseDown, true);
			this.overlay.removeEventListener('click', this.boundOnOverlayClick, true);
			if (this.overlay.parentNode) {
				this.overlay.parentNode.removeChild(this.overlay);
			}
			this.overlay = null;
		}
		
		// Clear listeners
		this.listeners = [];
		
		// Exit pointer lock if active
		if (this.isLocked) {
			this.exitLock();
		}
	}
}

