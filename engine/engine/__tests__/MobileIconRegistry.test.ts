import { MobileIconRegistry } from 'engine/MobileActionSpec.js';

describe('MobileIconRegistry', () => {
    // The registry is a process-global static. Snapshot any built-ins this
    // suite overwrites so later tests in the same Jest worker don't see
    // our test-only icons.
    let originalShoot: ReturnType<typeof MobileIconRegistry.get>;

    beforeAll(() => {
        originalShoot = MobileIconRegistry.get('shoot');
    });

    afterAll(() => {
        if (originalShoot) MobileIconRegistry.register('shoot', originalShoot);
    });

    it('returns built-in icons as theme-friendly text (never emojis)', () => {
        const jump = MobileIconRegistry.get('jump');
        expect(jump?.kind).toBe('text');
        expect(jump?.value).toBe('JUMP');
    });

    it('allows registering new icons and they override built-ins', () => {
        MobileIconRegistry.register('shoot', { kind: 'url', value: '/assets/fire.svg' });
        expect(MobileIconRegistry.get('shoot')).toEqual({ kind: 'url', value: '/assets/fire.svg' });
    });

    it('returns undefined for unknown keys', () => {
        expect(MobileIconRegistry.get('nonexistent-key')).toBeUndefined();
    });
});
