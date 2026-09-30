/**
 * Pre-play selection steps for the main screen (StartScreen).
 *
 * Config: `worldProfileData.hud.startScreen.selections[]` (see
 * StartScreenSelection in types/game.ts). This module turns that config into
 * presentable steps and builds their DOM; the PRESENTATION lifecycle (when a
 * step appears, what happens to the pick) is owned by StartScreen +
 * GameTemplate:
 *
 *   - the 'level' step is presented BEFORE the world loads (its pick decides
 *     what to load — GameEngine.loadGame({ bootLevelId }));
 *   - 'choice' steps are presented after loading, before the Play button, and
 *     land in engine.getPreGameSelections().
 *
 * Resolution is deliberately lenient: malformed steps are dropped with a
 * console warning — a bad selections[] block must never keep a game from
 * loading.
 */

import { t } from 'engine/i18n/index.js';
import { resolveLevels } from 'engine/levels/levelResolve.js';
import type { GameData, StartScreenSelection } from 'types/game.js';

export interface SelectionStepOption {
    id: string;
    label: string;
    imageUrl?: string;
}

/**
 * How a presented step resolved. `userPicked` distinguishes a real tap from a
 * fallback resolution (force-started gameplay, editor-tab cancel, busy guard):
 * fallbacks still carry a usable option id, but must not be REMEMBERED as the
 * player's session pick, and they signal the presenting flow was interrupted.
 */
export interface SelectionResolution {
    optionId: string;
    userPicked: boolean;
}

/** A validated, presentable selection step (always ≥ 2 options). */
export interface SelectionStepSpec {
    id: string;
    kind: 'level' | 'choice';
    /** Authored heading; '' = let the DOM builder pick the translated default. */
    title: string;
    options: SelectionStepOption[];
}

export interface ResolvedSelections {
    /** At most one level chooser (first 'level' step wins), or null. */
    levelStep: SelectionStepSpec | null;
    /** All presentable 'choice' steps, in authored order. */
    choiceSteps: SelectionStepSpec[];
}

/**
 * Validate + resolve the authored selections into presentable steps.
 * Level options come from the level registry (filtered by `levelIds` when
 * given); a level step needs ≥ 2 offered levels, a choice step ≥ 2 options.
 */
export function resolveStartScreenSelections(gameData: GameData | null | undefined): ResolvedSelections {
    const none: ResolvedSelections = { levelStep: null, choiceSteps: [] };
    const selections = gameData?.worldProfileData?.hud?.startScreen?.selections;
    if (!Array.isArray(selections) || selections.length === 0) return none;

    const resolved: ResolvedSelections = { levelStep: null, choiceSteps: [] };
    for (const step of selections as StartScreenSelection[]) {
        if (!step || typeof step.id !== 'string' || step.id === '') {
            console.warn('[Selections] dropping step without an id:', step);
            continue;
        }
        if (step.type === 'level') {
            if (resolved.levelStep) {
                console.warn(`[Selections] dropping extra level step "${step.id}" — only one level chooser is supported`);
                continue;
            }
            const levels = resolveLevels(gameData ?? null);
            if (!levels) {
                console.warn(`[Selections] dropping level step "${step.id}" — game has no levels[]`);
                continue;
            }
            const offered = step.levelIds
                ? levels.levels.filter((l) => step.levelIds!.includes(l.id))
                : levels.levels;
            if (step.levelIds && offered.length !== step.levelIds.length) {
                console.warn(`[Selections] level step "${step.id}": some levelIds are not in levels[] and were skipped`);
            }
            if (offered.length < 2) {
                // A single (or zero) offered level is not a choice — boot normally.
                continue;
            }
            resolved.levelStep = {
                id: step.id,
                kind: 'level',
                title: step.title ?? '',
                options: offered.map((l) => ({ id: l.id, label: l.name || l.id })),
            };
        } else if (step.type === 'choice') {
            const options = (step.options ?? []).filter(
                (o): o is SelectionStepOption => !!o && typeof o.id === 'string' && o.id !== '' && typeof o.label === 'string',
            );
            if (options.length < 2) {
                console.warn(`[Selections] dropping choice step "${step.id}" — needs at least 2 valid options`);
                continue;
            }
            resolved.choiceSteps.push({ id: step.id, kind: 'choice', title: step.title ?? '', options });
        } else {
            console.warn(`[Selections] dropping step "${step.id}" with unknown type "${(step as { type?: string }).type}"`);
        }
    }
    return resolved;
}

/** The DEFAULT pick for a step — used by auto-skipping flows (editor preview,
 *  autostart) so game code always finds a value for every configured step. */
export function defaultPick(step: SelectionStepSpec): string {
    return step.options[0]!.id;
}

/**
 * Build a selection step's DOM: a heading plus one button per option.
 * Pure DOM construction — the caller mounts it, and `onPick` fires with the
 * chosen option id (buttons stop propagation the same way the Play button
 * does, so taps never fall through to game input). The translated default
 * heading is applied HERE, not at resolve time, so resolution stays free of
 * i18n/window dependencies.
 */
export function buildSelectionStepElement(step: SelectionStepSpec, onPick: (optionId: string) => void): HTMLElement {
    const root = document.createElement('div');
    root.className = 'start-screen-selection';
    root.dataset.selectionId = step.id;

    const titleText = step.title || (step.kind === 'level' ? t('game.select.level') : '');
    if (titleText) {
        const title = document.createElement('div');
        title.className = 'start-screen-selection__title';
        title.textContent = titleText;
        root.appendChild(title);
    }

    const list = document.createElement('div');
    list.className = 'start-screen-selection__options';
    for (const option of step.options) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ui-modal-button start-screen-selection__option';
        if (option.imageUrl) {
            const img = document.createElement('img');
            img.className = 'start-screen-selection__option-image';
            img.src = option.imageUrl;
            img.alt = '';
            button.appendChild(img);
        }
        const label = document.createElement('span');
        label.textContent = option.label;
        button.appendChild(label);

        button.addEventListener('mousedown', (e: MouseEvent) => { e.stopPropagation(); });
        button.addEventListener('mouseup', (e: MouseEvent) => { e.stopPropagation(); });
        button.addEventListener('click', (e: MouseEvent) => {
            e.stopPropagation();
            onPick(option.id);
        });
        button.addEventListener('touchstart', (e: TouchEvent) => { e.stopPropagation(); }, { passive: false });
        button.addEventListener('touchend', (e: TouchEvent) => {
            e.stopPropagation();
            e.preventDefault();
            onPick(option.id);
        });
        list.appendChild(button);
    }
    root.appendChild(list);
    return root;
}
