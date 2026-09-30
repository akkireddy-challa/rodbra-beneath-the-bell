import { DEFAULT_SKI_CONFIG, mergeSkiConfig } from 'engine/ski/SkiConfig.js';

describe('mergeSkiConfig', () => {
	it('returns defaults when called with no overrides', () => {
		expect(mergeSkiConfig()).toEqual(DEFAULT_SKI_CONFIG);
		expect(mergeSkiConfig()).not.toBe(DEFAULT_SKI_CONFIG); // fresh object
	});

	it('applies known overrides', () => {
		const cfg = mergeSkiConfig({ maxSpeed: 40, showPoles: false });
		expect(cfg.maxSpeed).toBe(40);
		expect(cfg.showPoles).toBe(false);
		expect(cfg.jumpSpeed).toBe(DEFAULT_SKI_CONFIG.jumpSpeed);
	});

	it('drops unknown keys and type-mismatched values (world.json safety)', () => {
		const cfg = mergeSkiConfig({
			maxSpeed: 'fast', // wrong type
			bogusKey: 123,    // unknown key
			tuckMaxSpeed: 44, // valid
		} as Record<string, unknown>);
		expect(cfg.maxSpeed).toBe(DEFAULT_SKI_CONFIG.maxSpeed);
		expect((cfg as Record<string, unknown>).bogusKey).toBeUndefined();
		expect(cfg.tuckMaxSpeed).toBe(44);
	});
});
