import { MobileButtonLayout } from 'engine/MobileButtonLayout.js';
import type { MobileSlot } from 'engine/MobileActionSpec.js';

describe('MobileButtonLayout', () => {
    it('assigns preferred slot when free', () => {
        const layout = new MobileButtonLayout();
        const pos = layout.assign('shoot', 'primary');
        expect(pos).toEqual(layout.positionFor('primary'));
    });

    it('falls back to next free slot when preferred taken', () => {
        const layout = new MobileButtonLayout();
        layout.assign('shoot', 'primary');
        const pos = layout.assign('build', 'primary');
        expect(pos).toEqual(layout.positionFor('secondary'));
    });

    it('logs and returns preferred slot when all slots exhausted (no throw)', () => {
        const layout = new MobileButtonLayout();
        const slots: MobileSlot[] = ['primary', 'secondary', 'ascend', 'descend', 'left-1', 'left-2', 'left-3', 'top-left', 'top-right'];
        for (const s of slots) layout.assign(`a-${s}`, s);

        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const pos = layout.assign('overflow', 'primary');
            expect(pos).toEqual(layout.positionFor('primary'));
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(errorSpy.mock.calls[0][0]).toMatch(/No free slots for action 'overflow'/);
        } finally {
            errorSpy.mockRestore();
        }
    });

    describe('slots the engine owns', () => {
        // On a touch device the pause button sits at top-right in the HUD layer,
        // over the top-right slot. `reserved` stands in for isPauseButtonShown().
        const reserved = (slot: MobileSlot): boolean => slot === 'top-right';

        it('never hands out a reserved slot, even when it is preferred', () => {
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            try {
                const layout = new MobileButtonLayout(reserved);
                const pos = layout.assign('map', 'top-right');
                expect(pos).toEqual(layout.positionFor('primary'));
                expect(warnSpy.mock.calls[0][0]).toMatch(/belongs to the engine's pause button/);
            } finally {
                warnSpy.mockRestore();
            }
        });

        it('skips the reserved slot when falling back', () => {
            const layout = new MobileButtonLayout(reserved);
            const slots: MobileSlot[] = ['primary', 'secondary', 'ascend', 'descend', 'left-1', 'left-2', 'left-3'];
            for (const s of slots) layout.assign(`a-${s}`, s);
            // Only top-left is left: top-right belongs to the pause button.
            expect(layout.assign('map', 'primary')).toEqual(layout.positionFor('top-left'));
        });

        it('hands out top-right once the game hides the pause button', () => {
            const layout = new MobileButtonLayout(() => false);
            expect(layout.assign('map', 'top-right')).toEqual(layout.positionFor('top-right'));
        });

        it('names the reservation when every slot is gone', () => {
            const layout = new MobileButtonLayout(reserved);
            const slots: MobileSlot[] = ['primary', 'secondary', 'ascend', 'descend', 'left-1', 'left-2', 'left-3', 'top-left'];
            const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
            const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            try {
                for (const s of slots) layout.assign(`a-${s}`, s);
                layout.assign('overflow', 'primary');
                expect(errorSpy.mock.calls[0][0]).toMatch(/top-right:engine pause button/);
            } finally {
                warnSpy.mockRestore();
                errorSpy.mockRestore();
            }
        });
    });

    it('retains slot occupancy across repeated calls (shared layout usage)', () => {
        // Simulates declareMobileActions and a later registerCustomAction sharing the same layout.
        const layout = new MobileButtonLayout();
        const posA = layout.assign('shoot', 'primary');
        const posB = layout.assign('build', 'secondary');
        // Now a third call with preferred='primary' should fall back past primary + secondary.
        const posC = layout.assign('reload', 'primary');
        expect(posA).toEqual(layout.positionFor('primary'));
        expect(posB).toEqual(layout.positionFor('secondary'));
        expect(posC).toEqual(layout.positionFor('ascend'));
    });
});
