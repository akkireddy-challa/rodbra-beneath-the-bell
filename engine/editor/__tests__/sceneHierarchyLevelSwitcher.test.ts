/**
 * Level dropdown in the Scene Hierarchy panel — a temporary editor-session
 * level preview wired straight to the LevelManager (no postMessage hop).
 *
 * @jest-environment jsdom
 */
import * as THREE from 'three';
import { SceneHierarchyPanel } from 'editor/SceneHierarchyPanel.js';
import { setActiveLevelManager } from 'engine/levels/levelManagerRegistry.js';
import type { LevelManager } from 'engine/levels/LevelManager.js';

const postToCreator = jest.fn();
jest.mock('engine/CreatorMode.js', () => ({
    safePostMessageToCreator: (msg: unknown) => postToCreator(msg),
}));
jest.mock('engine/i18n/index.js', () => ({ t: (key: string) => key }));

interface FakeManager {
    manager: LevelManager;
    emitDidLoad: (levelId: string) => void;
    loadLevel: jest.Mock;
}

function makeFakeManager(
    levels: Array<{ id: string; name: string }> = [
        { id: 'l1', name: 'One' },
        { id: 'l2', name: 'Two' },
    ],
): FakeManager {
    const didLoadCbs: Array<(levelId: string) => void> = [];
    let active = levels[0]!.id;
    const loadLevel = jest.fn(async (levelId: string) => { active = levelId; });
    const manager = {
        getLevels: () => levels,
        getActiveLevelId: () => active,
        loadLevel,
        onLevelDidLoad: (cb: (levelId: string) => void) => { didLoadCbs.push(cb); },
    } as unknown as LevelManager;
    return { manager, loadLevel, emitDidLoad: (id) => { active = id; didLoadCbs.forEach((cb) => cb(id)); } };
}

function makePanel(): { panel: SceneHierarchyPanel; container: HTMLDivElement } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const panel = new SceneHierarchyPanel(new THREE.Scene(), container, () => {});
    panel.createPanel();
    return { panel, container };
}

function getSelect(container: HTMLDivElement): HTMLSelectElement | null {
    return container.querySelector('.bm-editor-level-select');
}

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
    setActiveLevelManager(null);
    postToCreator.mockReset();
    document.body.innerHTML = '';
});

describe('SceneHierarchyPanel level switcher', () => {
    it('renders no dropdown without a LevelManager (legacy single-world game)', () => {
        setActiveLevelManager(null);
        const { container } = makePanel();
        expect(getSelect(container)).toBeNull();
    });

    it('renders no dropdown for a single-level game', () => {
        setActiveLevelManager(makeFakeManager([{ id: 'l1', name: 'One' }]).manager);
        const { container } = makePanel();
        expect(getSelect(container)).toBeNull();
    });

    it('lists all levels with the active one selected', () => {
        setActiveLevelManager(makeFakeManager().manager);
        const { container } = makePanel();
        const select = getSelect(container)!;
        expect(select).not.toBeNull();
        expect(Array.from(select.options).map((o) => o.value)).toEqual(['l1', 'l2']);
        expect(select.value).toBe('l1');
    });

    it('switches via loadLevel(networked:false) and acks LEVEL_LOADED success', async () => {
        const fake = makeFakeManager();
        setActiveLevelManager(fake.manager);
        const { container } = makePanel();
        const select = getSelect(container)!;
        select.value = 'l2';
        select.dispatchEvent(new Event('change'));
        await flush();
        expect(fake.loadLevel).toHaveBeenCalledWith('l2', { networked: false });
        expect(postToCreator).toHaveBeenCalledWith({ type: 'LEVEL_LOADED', levelId: 'l2', success: true });
        expect(select.disabled).toBe(false);
    });

    it('reverts the selection and acks failure when loadLevel rejects', async () => {
        const fake = makeFakeManager();
        fake.loadLevel.mockRejectedValueOnce(new Error('boom'));
        setActiveLevelManager(fake.manager);
        const { container } = makePanel();
        const select = getSelect(container)!;
        select.value = 'l2';
        select.dispatchEvent(new Event('change'));
        await flush();
        expect(select.value).toBe('l1');
        expect(postToCreator).toHaveBeenCalledWith({
            type: 'LEVEL_LOADED', levelId: 'l2', success: false, error: 'boom',
        });
    });

    it('syncs the selection when a switch completes elsewhere (Levels tab)', () => {
        const fake = makeFakeManager();
        setActiveLevelManager(fake.manager);
        const { container } = makePanel();
        fake.emitDidLoad('l2');
        expect(getSelect(container)!.value).toBe('l2');
    });

    it('appears after refresh when LevelManager is installed after createPanel() (production ordering)', () => {
        setActiveLevelManager(null);
        const { panel, container } = makePanel();
        expect(getSelect(container)).toBeNull();

        const fake = makeFakeManager();
        setActiveLevelManager(fake.manager);
        panel.refresh();

        const select = getSelect(container)!;
        expect(select).not.toBeNull();
        expect(Array.from(select.options).map((o) => o.value)).toEqual(['l1', 'l2']);
        expect(select.value).toBe('l1');
    });

    it('appears after show() when LevelManager is installed after createPanel()', () => {
        setActiveLevelManager(null);
        const { panel, container } = makePanel();
        expect(getSelect(container)).toBeNull();

        const fake = makeFakeManager();
        setActiveLevelManager(fake.manager);
        panel.show();

        const select = getSelect(container)!;
        expect(select).not.toBeNull();
        expect(select.value).toBe('l1');
    });
});
