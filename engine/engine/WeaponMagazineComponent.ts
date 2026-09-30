/**
 * @fileoverview WeaponMagazineComponent - Default magazine implementation
 *
 * Standard timed-reload magazine component for RangedWeaponSystem.
 * Template code can instantiate with custom config or implement IWeaponMagazine
 * for fully custom behavior.
 */

import type { IWeaponMagazine } from 'engine/IWeaponMagazine.js';

export interface WeaponMagazineConfig {
	magazineSize: number;
	reloadDuration?: number;  // default 1500ms
	startLoaded?: boolean;    // default true
	autoReload?: boolean;     // default true — auto-reload when empty
	reloadEnabled?: boolean;  // default true — whether reload is allowed at all
}

export class WeaponMagazineComponent implements IWeaponMagazine {
	private currentAmmo: number;
	private magazineSize: number;
	private isReloading: boolean = false;
	private reloadStartTime: number = 0;
	private reloadDuration: number;
	private autoReload: boolean;
	private reloadEnabled: boolean;

	constructor(config: WeaponMagazineConfig) {
		this.magazineSize = config.magazineSize;
		this.reloadDuration = config.reloadDuration ?? 1500;
		this.currentAmmo = (config.startLoaded ?? true) ? config.magazineSize : 0;
		this.autoReload = config.autoReload ?? true;
		this.reloadEnabled = config.reloadEnabled ?? true;
	}

	/**
	 * A magazine of size 0 is INFINITE: it never empties and never reloads.
	 * The convention every weapon preset and HUD formatter shares.
	 */
	isInfinite(): boolean {
		return this.magazineSize === 0;
	}

	tryConsume(): boolean {
		if (this.isInfinite()) return true;
		if (this.isReloading || this.currentAmmo <= 0) {
			return false;
		}
		this.currentAmmo--;
		return true;
	}

	startReload(): void {
		if (!this.reloadEnabled || this.isInfinite()) return;
		if (this.isReloading || this.currentAmmo >= this.magazineSize) return;

		this.isReloading = true;
		this.reloadStartTime = performance.now();
		console.log(`Reloading... (${this.currentAmmo}/${this.magazineSize})`);
	}

	update(): void {
		if (!this.isReloading) return;

		const elapsed = performance.now() - this.reloadStartTime;
		if (elapsed >= this.reloadDuration) {
			this.isReloading = false;
			this.currentAmmo = this.magazineSize;
			console.log(`Reload complete (${this.currentAmmo}/${this.magazineSize})`);
		}
	}

	reset(magazineSize: number, reloadDuration?: number): void {
		this.magazineSize = magazineSize;
		this.currentAmmo = magazineSize;
		this.isReloading = false;
		this.reloadStartTime = 0;
		if (reloadDuration !== undefined) {
			this.reloadDuration = reloadDuration;
		}
	}

	getCurrentAmmo(): number {
		return this.isInfinite() ? Number.POSITIVE_INFINITY : this.currentAmmo;
	}

	getMagazineSize(): number {
		return this.magazineSize;
	}

	getIsReloading(): boolean {
		return this.isReloading;
	}

	getAmmoState(): { current: number; max: number; isReloading: boolean } {
		return {
			current: this.currentAmmo,
			max: this.magazineSize,
			isReloading: this.isReloading
		};
	}

	setReloadDuration(ms: number): void {
		this.reloadDuration = ms;
	}

	getReloadDuration(): number {
		return this.reloadDuration;
	}

	isAutoReloadEnabled(): boolean {
		return this.autoReload;
	}

	isReloadAllowed(): boolean {
		return this.reloadEnabled;
	}

	setAutoReload(enabled: boolean): void {
		this.autoReload = enabled;
	}

	setReloadEnabled(enabled: boolean): void {
		this.reloadEnabled = enabled;
	}
}
