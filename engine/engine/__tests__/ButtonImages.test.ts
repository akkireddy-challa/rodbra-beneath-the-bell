/**
 * @jest-environment jsdom
 *
 * Engine-built buttons accept images: HUD action-row buttons take `imageUrl`
 * (with or without a label), and mobile touch buttons draw a
 * `{ kind: 'url' }` MobileIconRegistry icon instead of dropping it for text.
 */
import { GameHUD } from 'engine/GameHUD.js';
import { MobileControls } from 'engine/MobileControls.js';
import { MobileIconRegistry } from 'engine/MobileActionSpec.js';

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

function setUserAgent(ua: string): void {
    Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

function actionButton(rowId: string, controlId: string): HTMLButtonElement {
    const el = document.querySelector<HTMLButtonElement>(`#hud-action-row-${rowId} [data-control-id="${controlId}"]`);
    if (!el) throw new Error(`no control ${controlId} in row ${rowId}`);
    return el;
}

describe('HUD action-row button images', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    });

    it('renders the image ahead of the label', () => {
        const hud = new GameHUD();
        hud.createActionRow('shop', {
            controls: [{ id: 'buy', label: 'Buy', imageUrl: '/assets/coin.png' }],
        });
        const button = actionButton('shop', 'buy');
        const img = button.querySelector('img');
        expect(img?.getAttribute('src')).toBe('/assets/coin.png');
        expect(img?.className).toBe('hud-action-button__image');
        expect(button.querySelector('.hud-action-button__label')?.textContent).toBe('Buy');
        expect(button.getAttribute('aria-label')).toBe('Buy');
        expect(button.classList.contains('hud-action-button--image-only')).toBe(false);
    });

    it('imageOnly hides the label but keeps it as the accessible name', () => {
        const hud = new GameHUD();
        hud.createActionRow('tools', {
            controls: [{ id: 'pick', label: 'Pickaxe', imageUrl: '/assets/pick.svg', imageOnly: true }],
        });
        const button = actionButton('tools', 'pick');
        expect(button.querySelector('.hud-action-button__label')).toBeNull();
        expect(button.getAttribute('aria-label')).toBe('Pickaxe');
        expect(button.classList.contains('hud-action-button--image-only')).toBe(true);
    });

    it('updates the label without losing the image, and removes the image on null', () => {
        const hud = new GameHUD();
        hud.createActionRow('shop', {
            controls: [{ id: 'buy', label: 'Buy', imageUrl: '/assets/coin.png' }],
        });
        hud.updateActionControl('shop', 'buy', { label: 'Sold out' });
        let button = actionButton('shop', 'buy');
        expect(button.querySelector('img')?.getAttribute('src')).toBe('/assets/coin.png');
        expect(button.textContent).toBe('Sold out');

        hud.updateActionControl('shop', 'buy', { imageUrl: '/assets/gem.png' });
        button = actionButton('shop', 'buy');
        expect(button.querySelector('img')?.getAttribute('src')).toBe('/assets/gem.png');
        expect(button.textContent).toBe('Sold out');

        hud.updateActionControl('shop', 'buy', { imageUrl: null });
        expect(actionButton('shop', 'buy').querySelector('img')).toBeNull();
        expect(actionButton('shop', 'buy').textContent).toBe('Sold out');
    });

    it('text-only buttons still render just their label', () => {
        const hud = new GameHUD();
        hud.createActionRow('wave', { controls: [{ id: 'start', label: 'Start' }] });
        const button = actionButton('wave', 'start');
        expect(button.querySelector('img')).toBeNull();
        expect(button.textContent).toBe('Start');
    });
});

describe('mobile button images', () => {
    let controls: MobileControls;
    let originalShoot: ReturnType<typeof MobileIconRegistry.get>;

    beforeAll(() => {
        originalShoot = MobileIconRegistry.get('shoot');
    });

    afterAll(() => {
        if (originalShoot) MobileIconRegistry.register('shoot', originalShoot);
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
        controls = new MobileControls();
    });

    afterEach(() => {
        controls.dispose();
    });

    it('draws a URL icon on the action button instead of falling back to text', () => {
        MobileIconRegistry.register('shoot', { kind: 'url', value: '/assets/fire.svg' });
        controls.setActionType('shoot');
        const btn = controls.getButton('action');
        expect(btn?.querySelector('img')?.getAttribute('src')).toBe('/assets/fire.svg');
        expect(btn?.classList.contains('hud-mobile-button--image-only')).toBe(true);
        expect(btn?.getAttribute('aria-label')).toBe('SHOOT');

        // Switching back to a text icon clears the image.
        controls.setActionType('jump');
        expect(btn?.querySelector('img')).toBeNull();
        expect(btn?.textContent).toBe('JUMP');
    });

    it('custom actions accept an imageUrl', () => {
        controls.registerAction({ action: 'dash', label: 'DASH', imageUrl: '/assets/dash.png', behavior: 'tap' });
        const btn = controls.getButton('dash');
        expect(btn?.querySelector('img')?.getAttribute('src')).toBe('/assets/dash.png');
        expect(btn?.getAttribute('aria-label')).toBe('DASH');
    });
});
