/**
 * @jest-environment jsdom
 *
 * Regression tests for managed HUD action rows (GameHUD.createActionRow).
 *
 * These cover the three ways free-form `createCustomElement` UI kept failing in
 * production: controls landing off-screen on phones, controls ending up nested
 * inside a game panel instead of anchored to the screen, and keystrokes/clicks
 * meant for the UI leaking into gameplay. jsdom does no layout, so the layout
 * guarantees are asserted where they actually live — the element tree and the
 * base stylesheet.
 */
import { GameHUD } from 'engine/GameHUD.js';
import { HUD_BASE_STYLES } from 'engine/hud/hudBaseStyles.js';

// jsdom ships no matchMedia, and the HUD queries it while building its layers.
beforeAll(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener() {}, removeListener() {},
            addEventListener() {}, removeEventListener() {},
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
});

const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const PORTRAIT_PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)';

function setUserAgent(ua: string): void {
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

function makeHud(ua: string = DESKTOP_UA): GameHUD {
    document.body.innerHTML = '';
    setUserAgent(ua);
    return new GameHUD();
}

function rowOf(id: string): HTMLElement {
    const el = document.getElementById(`hud-action-row-${id}`);
    if (!el) throw new Error(`action row not created: ${id}`);
    return el;
}

function buttonOf(rowId: string): HTMLButtonElement {
    const el = rowOf(rowId).querySelector('button');
    if (!el) throw new Error(`no button in action row: ${rowId}`);
    return el;
}

function inputOf(rowId: string): HTMLInputElement {
    const el = rowOf(rowId).querySelector('input');
    if (!el) throw new Error(`no text input in action row: ${rowId}`);
    return el;
}

/**
 * Minimal PlayerController stand-in — only the controls-enabled pair matters for
 * these tests. Returns a reader for the current gameplay-controls state.
 */
function installFakeController(hud: GameHUD, controlsEnabled: boolean): () => boolean {
    let enabled = controlsEnabled;
    const controller = {
        getControlsEnabled: () => enabled,
        setControlsEnabled: (next: boolean) => { enabled = next; },
        getPlayerHealth: () => 100,
        getPlayerMaxHealth: () => 100,
        onHealthChanged: undefined as ((current: number, max: number) => void) | undefined,
    };
    hud.setPlayerController(controller as unknown as Parameters<GameHUD['setPlayerController']>[0]);
    return () => enabled;
}

const detachDocumentSpies: Array<() => void> = [];

/**
 * Records everything of `types` that reaches `document` — where DesktopControls,
 * MobileControls and the HUD's own shortcut all listen. Keyboard events are
 * recorded by key, others by type. Detached automatically after each test.
 */
function watchDocument(...types: string[]): string[] {
    const seen: string[] = [];
    const handler = (event: Event): void => {
        seen.push(event instanceof KeyboardEvent ? event.key : event.type);
    };
    for (const type of types) document.addEventListener(type, handler);
    detachDocumentSpies.push(() => {
        for (const type of types) document.removeEventListener(type, handler);
    });
    return seen;
}

afterEach(() => {
    for (const detach of detachDocumentSpies.splice(0)) detach();
    document.body.innerHTML = '';
    setUserAgent(DESKTOP_UA);
});

describe('managed action rows — desktop', () => {
    it('mounts on the anchor stack, never inside another element', () => {
        const hud = makeHud();
        // A game panel at the same anchor — the row must be its SIBLING, which is
        // what "outside the tower panel" means structurally.
        hud.createCustomElement('tower-panel', { anchor: 'top-right', html: '<div>Towers</div>' });
        hud.createActionRow('wave-actions', {
            anchor: 'top-right',
            controls: [
                { id: 'start', label: 'Start Wave', variant: 'primary', size: 'large' },
                { id: 'cancel', label: 'Cancel', variant: 'danger' },
            ],
        });

        const row = rowOf('wave-actions');
        const panel = document.getElementById('hud-custom-tower-panel');
        expect(panel?.contains(row)).toBe(false);
        expect((row.parentElement as HTMLElement).dataset.anchor).toBe('top-right');
        expect(row.parentElement?.classList.contains('hud-anchor-stack')).toBe(true);
    });

    it('renders each control as a real form element with its variant class', () => {
        const hud = makeHud();
        hud.createActionRow('wave-actions', {
            anchor: 'top-right',
            controls: [
                { id: 'start', label: 'Start Wave', variant: 'primary', size: 'large' },
                { id: 'cancel', label: 'Cancel', variant: 'danger' },
            ],
        });

        const buttons = rowOf('wave-actions').querySelectorAll('button.hud-action-button');
        expect(buttons.length).toBe(2);
        expect(buttons[0]?.className).toContain('hud-action-button--primary');
        expect(buttons[0]?.className).toContain('hud-action-button--large');
        expect(buttons[0]?.textContent).toBe('Start Wave');
        expect(buttons[1]?.className).toContain('hud-action-button--danger');
    });

    it('fires onSelect on click and supports show / hide / update / remove', () => {
        const hud = makeHud();
        let started = 0;
        hud.createActionRow('wave-actions', {
            anchor: 'top-right',
            controls: [{ id: 'start', label: 'Start Wave', variant: 'primary', onSelect: () => { started++; } }],
        });
        const button = buttonOf('wave-actions');

        button.click();
        expect(started).toBe(1);

        hud.updateActionControl('wave-actions', 'start', { label: 'Wave 2', variant: 'warning', disabled: true });
        expect(button.textContent).toBe('Wave 2');
        expect(button.className).toContain('hud-action-button--warning');
        expect(button.className).not.toContain('hud-action-button--primary');
        expect(button.disabled).toBe(true);

        // A disabled control stays inert even if something dispatches a click.
        button.click();
        expect(started).toBe(1);

        hud.updateActionControl('wave-actions', 'start', { visible: false });
        expect(button.hidden).toBe(true);

        hud.setActionRowVisible('wave-actions', false);
        expect(rowOf('wave-actions').style.display).toBe('none');
        hud.setActionRowVisible('wave-actions', true);
        expect(rowOf('wave-actions').style.display).toBe('');

        hud.removeActionRow('wave-actions');
        expect(document.getElementById('hud-action-row-wave-actions')).toBeNull();
        expect(hud.getElement('wave-actions')).toBeUndefined();
    });

    it('keeps a 44px desktop tap target and no forced touch sizing', () => {
        const hud = makeHud();
        hud.createActionRow('wave-actions', { anchor: 'top-right', controls: [{ id: 'start', label: 'Go' }] });
        expect(rowOf('wave-actions').dataset.touch).toBeUndefined();
        expect(HUD_BASE_STYLES).toContain('--hud-tap-target: 44px;');
        expect(HUD_BASE_STYLES).toContain('min-height: var(--hud-tap-target, 44px);');
    });
});

describe('managed action rows — portrait phone', () => {
    it('marks the row as a touch runtime so controls get 60px tap targets', () => {
        const hud = makeHud(PORTRAIT_PHONE_UA);
        hud.createActionRow('wave-actions', {
            anchor: 'top-right',
            controls: [{ id: 'start', label: 'Start Wave', variant: 'primary', size: 'large' }],
        });
        expect(rowOf('wave-actions').dataset.touch).toBe('true');
        expect(HUD_BASE_STYLES).toContain('.hud-action-row[data-touch="true"] { --hud-tap-target: 60px; }');
        expect(HUD_BASE_STYLES).toContain('@media (pointer: coarse) {');
    });

    it('reserves the device safe-area insets and wraps instead of overflowing', () => {
        const hud = makeHud(PORTRAIT_PHONE_UA);
        hud.createActionRow('wave-actions', {
            anchor: 'top-right',
            controls: [{ id: 'start', label: 'Start Wave' }, { id: 'cancel', label: 'Cancel' }],
        });
        expect(rowOf('wave-actions').dataset.wrap).toBe('true');
        expect(HUD_BASE_STYLES).toContain('margin-left: env(safe-area-inset-left, 0px);');
        expect(HUD_BASE_STYLES).toContain('[data-anchor^="top-"]     > .hud-action-row { margin-top: env(safe-area-inset-top, 0px); }');
        expect(HUD_BASE_STYLES).toContain('[data-anchor^="bottom-"]  > .hud-action-row { margin-bottom: env(safe-area-inset-bottom, 0px); }');
        // Portrait phones stack the controls full-width rather than clipping the
        // last one at the screen edge.
        expect(HUD_BASE_STYLES).toContain('@media (max-width: 480px) and (orientation: portrait) {');
    });

    it('lets the mobile touch layer through so taps are not swallowed', () => {
        const hud = makeHud(PORTRAIT_PHONE_UA);
        hud.createActionRow('wave-actions', { anchor: 'top-right', controls: [{ id: 'start', label: 'Go' }] });
        expect(rowOf('wave-actions').dataset.hudInteractive).toBe('true');
    });
});

describe('managed action rows — gameplay input suppression', () => {
    it('stops pointer events reaching the document input layers', () => {
        const hud = makeHud();
        const seen = watchDocument('mousedown', 'click');

        hud.createActionRow('wave-actions', { anchor: 'top-right', controls: [{ id: 'start', label: 'Go' }] });
        const button = buttonOf('wave-actions');
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        button.click();

        expect(seen).toEqual([]);
    });

    it('withholds a focused button’s activation keys but lets movement keys through', () => {
        const hud = makeHud();
        const seen = watchDocument('keydown');

        hud.createActionRow('wave-actions', { anchor: 'top-right', controls: [{ id: 'start', label: 'Go' }] });
        const button = buttonOf('wave-actions');
        button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));

        expect(seen).toEqual(['w']);
    });

    it('gives a focused text input the whole keyboard and commits on Enter', () => {
        const hud = makeHud();
        const seen = watchDocument('keydown');

        let committed: string | null = null;
        hud.createActionRow('wave-config', {
            anchor: 'top-right',
            controls: [{
                id: 'count', kind: 'text-input', label: 'Waves', value: '3',
                onSelect: (value) => { committed = value; },
            }],
        });
        const input = inputOf('wave-config');
        expect(hud.getActionControlValue('wave-config', 'count')).toBe('3');

        input.value = '12';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        expect(committed).toBe('12');
        expect(seen).toEqual([]);
    });

    it('freezes and restores player controls around text-input focus', () => {
        const hud = makeHud();
        const controlsEnabled = installFakeController(hud, true);

        hud.createActionRow('wave-config', {
            anchor: 'top-right',
            controls: [{ id: 'count', kind: 'text-input', label: 'Waves' }],
        });
        const input = inputOf('wave-config');

        input.dispatchEvent(new FocusEvent('focus'));
        expect(controlsEnabled()).toBe(false);
        input.dispatchEvent(new FocusEvent('blur'));
        expect(controlsEnabled()).toBe(true);
    });

    it('leaves already-frozen controls frozen after the field is dismissed', () => {
        const hud = makeHud();
        // e.g. a cutscene already froze the player before the field appeared.
        const controlsEnabled = installFakeController(hud, false);

        hud.createActionRow('wave-config', {
            anchor: 'top-right',
            controls: [{ id: 'count', kind: 'text-input', label: 'Waves' }],
        });
        const input = inputOf('wave-config');

        input.dispatchEvent(new FocusEvent('focus'));
        input.dispatchEvent(new FocusEvent('blur'));
        expect(controlsEnabled()).toBe(false);
    });
});
