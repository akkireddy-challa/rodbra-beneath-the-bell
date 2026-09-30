import { WeaponMagazineComponent } from 'engine/WeaponMagazineComponent.js';

/**
 * `magazineSize: 0` means INFINITE — the convention the old first-person
 * template shipped and the one every preset and HUD formatter now share.
 */
describe('infinite magazine', () => {
    it('never empties and never reloads', () => {
        const mag = new WeaponMagazineComponent({ magazineSize: 0 });
        expect(mag.isInfinite()).toBe(true);
        for (let i = 0; i < 500; i++) expect(mag.tryConsume()).toBe(true);
        expect(mag.getCurrentAmmo()).toBe(Number.POSITIVE_INFINITY);
        mag.startReload();
        expect(mag.getIsReloading()).toBe(false);
        expect(mag.getAmmoState().max).toBe(0);
    });

    it('can be reset into and out of infinity', () => {
        const mag = new WeaponMagazineComponent({ magazineSize: 12 });
        expect(mag.isInfinite()).toBe(false);
        mag.reset(0);
        expect(mag.isInfinite()).toBe(true);
        mag.reset(6);
        expect(mag.isInfinite()).toBe(false);
        expect(mag.getCurrentAmmo()).toBe(6);
    });

    it('leaves a finite magazine exactly as it was', () => {
        const mag = new WeaponMagazineComponent({ magazineSize: 3 });
        expect(mag.tryConsume()).toBe(true);
        expect(mag.tryConsume()).toBe(true);
        expect(mag.tryConsume()).toBe(true);
        expect(mag.tryConsume()).toBe(false);
        expect(mag.getCurrentAmmo()).toBe(0);
    });
});
