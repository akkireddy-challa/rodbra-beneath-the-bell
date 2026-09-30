import type { MobileSlot } from 'engine/MobileActionSpec.js';
import { isPauseButtonShown } from 'engine/ui/pauseButtonPolicy.js';

export interface MobileButtonPosition {
    bottom: string;
    right?: string;
    left?: string;
    top?: string;
    width: string;
    height: string;
    borderRadius: string;
    fontSize: string;
}

const SLOT_POSITIONS: Record<MobileSlot, MobileButtonPosition> = {
    primary:   { bottom: 'min(130px, 28vh)', right: '20px',  width: '70px', height: '70px', borderRadius: '50%',  fontSize: '24px' },
    secondary: { bottom: 'min(130px, 28vh)', right: '100px', width: '70px', height: '70px', borderRadius: '50%',  fontSize: '24px' },
    ascend:    { bottom: 'min(210px, 45vh)', right: '60px',  width: '70px', height: '70px', borderRadius: '50%',  fontSize: '14px' },
    descend:   { bottom: 'min(50px, 10vh)',  right: '60px',  width: '70px', height: '70px', borderRadius: '50%',  fontSize: '14px' },
    'left-1':  { bottom: 'min(130px, 28vh)', left: '20px',   width: '60px', height: '60px', borderRadius: '50%',  fontSize: '18px' },
    'left-2':  { bottom: 'min(200px, 42vh)', left: '20px',   width: '60px', height: '60px', borderRadius: '50%',  fontSize: '18px' },
    'left-3':  { bottom: 'min(270px, 56vh)', left: '20px',   width: '60px', height: '60px', borderRadius: '50%',  fontSize: '18px' },
    'top-left':  { top: '20px', left: '20px',  bottom: 'auto', width: 'auto', height: 'auto', borderRadius: '12px', fontSize: '16px' },
    'top-right': { top: '20px', right: '20px', bottom: 'auto', width: 'auto', height: 'auto', borderRadius: '12px', fontSize: '16px' },
};

const FALLBACK_ORDER: MobileSlot[] = [
    'primary', 'secondary', 'ascend', 'descend',
    'left-1', 'left-2', 'left-3',
    'top-right', 'top-left',
];

/**
 * Slots the engine's own on-screen chrome occupies, which a game's action buttons
 * must never be placed on. Today that is the touch pause button, which sits at
 * `top: 20px; right: 20px` in the HUD layer — the same spot as the `top-right`
 * slot below, in a different layer, so a button placed there lands underneath it.
 * Evaluated per assignment rather than captured at construction: a game hides the
 * pause button through world.json, and that flag is resolved during the load that
 * also builds this layout.
 */
function isEngineChromeSlot(slot: MobileSlot): boolean {
    return slot === 'top-right' && isPauseButtonShown();
}

export class MobileButtonLayout {
    private occupiedBy = new Map<MobileSlot, string>(); // slot → action

    /**
     * @param isReservedByEngine Overridable for tests; defaults to the real
     *                           on-screen chrome (see {@link isEngineChromeSlot}).
     */
    constructor(private readonly isReservedByEngine: (slot: MobileSlot) => boolean = isEngineChromeSlot) {}

    assign(action: string, preferred: MobileSlot): MobileButtonPosition {
        const slot = this.pickSlot(preferred);
        if (!slot) {
            console.error(
                `[MobileButtonLayout] No free slots for action '${action}' (preferred '${preferred}'). ` +
                `Occupied: ${Array.from(this.occupiedBy.entries()).map(([s, a]) => `${s}:${a}`).join(', ')}` +
                `${this.isReservedByEngine('top-right') ? ', top-right:engine pause button' : ''}. ` +
                `Falling back to '${preferred}' (button will overlap).`,
            );
            // Return preferred anyway — overlap is better than crashing game load.
            this.occupiedBy.set(preferred, action);
            return SLOT_POSITIONS[preferred];
        }
        if (slot !== preferred && this.isReservedByEngine(preferred)) {
            // Silently landing somewhere else would read as a layout bug to whoever
            // authored the spec, so name the button that owns the corner.
            console.warn(
                `[MobileButtonLayout] Slot '${preferred}' belongs to the engine's pause button; ` +
                `'${action}' moved to '${slot}'. Set world.json hud.pauseButton to 'hidden' if the ` +
                'game opens the pause card itself and wants that corner.',
            );
        }
        this.occupiedBy.set(slot, action);
        return SLOT_POSITIONS[slot];
    }

    positionFor(slot: MobileSlot): MobileButtonPosition {
        return SLOT_POSITIONS[slot];
    }

    private pickSlot(preferred: MobileSlot): MobileSlot | null {
        if (this.isFree(preferred)) return preferred;
        for (const s of FALLBACK_ORDER) if (this.isFree(s)) return s;
        return null;
    }

    private isFree(slot: MobileSlot): boolean {
        return !this.occupiedBy.has(slot) && !this.isReservedByEngine(slot);
    }

    reset(): void {
        this.occupiedBy.clear();
    }
}
