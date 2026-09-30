/**
 * @fileoverview IWeaponMagazine - Interface for weapon ammunition management
 *
 * Allows template code to either use the default WeaponMagazineComponent
 * or implement fully custom magazine behavior (infinite ammo, heat-based, etc.).
 */

/**
 * Interface for weapon magazine/ammunition management.
 *
 * Implement this interface to create custom magazine behavior,
 * or use the default WeaponMagazineComponent for standard timed reload.
 */
export interface IWeaponMagazine {
	/**
	 * Try to consume one round of ammunition.
	 * @returns true if ammo was consumed, false if empty or reloading
	 */
	tryConsume(): boolean;

	/**
	 * Begin the reload process.
	 * Should be a no-op if already reloading or magazine is full.
	 */
	startReload(): void;

	/**
	 * Frame update - advance reload timer or other per-frame logic.
	 */
	update(): void;

	/**
	 * Reinitialize for a new weapon configuration.
	 * @param magazineSize - New magazine capacity (0 to clear)
	 * @param reloadDuration - Optional reload time in milliseconds
	 */
	reset(magazineSize: number, reloadDuration?: number): void;

	/** Get current ammo count. */
	getCurrentAmmo(): number;

	/** Get magazine capacity. */
	getMagazineSize(): number;

	/** Check if currently reloading. */
	getIsReloading(): boolean;

	/** Get full ammo state for HUD display. */
	getAmmoState(): { current: number; max: number; isReloading: boolean };

	/** Set reload duration in milliseconds. */
	setReloadDuration(ms: number): void;

	/** Get current reload duration in milliseconds. */
	getReloadDuration(): number;

	/** Whether the magazine should auto-reload when empty. Default: true. */
	isAutoReloadEnabled(): boolean;

	/** Whether reload is allowed at all (manual or auto). Default: true. */
	isReloadAllowed(): boolean;

	/** Set whether auto-reload is enabled when magazine is empty. */
	setAutoReload(enabled: boolean): void;

	/** Set whether reload is allowed at all. When false, startReload() is a no-op. */
	setReloadEnabled(enabled: boolean): void;
}
