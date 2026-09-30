import type * as THREE from 'three';

/**
 * Internal reason key used by the `hide()` / `show()` runtime API.
 * Underscore-prefixed so user code that calls `setHideReason(...)` directly
 * is extremely unlikely to collide with it.
 */
const RUNTIME_HIDE_REASON = '__runtime-hide';

/**
 * Selector for body parts addressed by a hide-reason contribution.
 *
 * - `'all'` — every part is hidden for this reason (acts like a root hide).
 * - `string[]` — only the listed parts are hidden (by name, matching the
 *   direct child Group names on the block root — e.g. `'head'`, `'leftHand'`).
 * - `null` — remove this contribution entirely.
 */
export type BodyPartSelector = string[] | 'all' | null;

/**
 * Single owner of the player character's visibility.
 *
 * ## Runtime API (the common case)
 *
 * For ad-hoc "hide the character for a moment" use:
 *
 * `hide()` / `show()` compose with other subsystems — if the camera is in
 * first-person mode (CameraManager already hides), calling `show()` won't
 * reveal it because the `'first-person-mode'` reason is still active. The
 * character only becomes visible when every reason is cleared.
 *
 * Visibility and physics-enable are orthogonal — this class only deals with
 * visibility. To freeze the physics capsule and skip the update loop (board
 * games, cutscenes, full disable), call `PlayerController.setPlayerEnabled(false)`
 * in addition to `hide()`. The two together = fully disabled; either alone
 * = partial state (frozen-but-visible cutscene pose, or moving-but-invisible
 * stealth, depending on which you set).
 *
 * ## Composable API (for engine subsystems)
 *
 * Two channels, both composable:
 *
 * 1. **Hide reasons** — root-level. `setHideReason(reason, hide)`. Each
 *    subsystem contributes a named reason; the root is visible iff every
 *    reason is cleared and the manual override doesn't force a value.
 *
 * 2. **Body-part filter** — `setHiddenBodyParts(reason, parts)`. Applied to
 *    direct child Groups of the block root (each named for a body part by
 *    `BlockCharacterRenderer` — `'head'`, `'leftHand'`, etc.). Contributions
 *    union; a part is hidden iff any reason marks it.
 *
 * Channels compose: first-person mode hides the root (covers headless /
 * skeleton path) AND every body part (covers block-character path, lets
 * templates override the part list — e.g. show hands while hiding torso).
 *
 * ## Query semantics — important
 *
 * - `isVisible()` reflects the **root** only — the union of hide reasons +
 *   manual override. It does NOT consider the body-part filter, so a block
 *   character with `setHiddenBodyParts(..., 'all')` and a visible root will
 *   report `isVisible() === true` even though nothing renders. Use
 *   `isVisible()` to ask "is the root rendering?" — not "is anything
 *   visible to the user?".
 * - `isManuallyHidden()` reports only whether `hide()` is in effect. It is
 *   NOT the inverse of `isVisible()` and does NOT mean "currently invisible
 *   to the user".
 *
 * No traversal. Body parts are direct children of the block root, named by
 * the renderer. Sub-mesh visibility under a body part remains the
 * responsibility of whatever code placed those meshes.
 */
export class PlayerVisibility {
    private skeletonRoot: THREE.Object3D | null = null;
    private blockRoot: THREE.Object3D | null = null;
    private hideReasons = new Set<string>();
    private hiddenBodyPartsByReason = new Map<string, string[] | 'all'>();
    private manualOverride: boolean | null = null;

    // ─── Runtime API ────────────────────────────────────────────────────────

    /**
     * Hide the character at runtime. Pairs with `show()`. Idempotent.
     *
     * Composes with subsystem hide reasons — see class-level docs. Does NOT
     * touch the physics body; pair with `PlayerController.setPlayerEnabled(false)`
     * if you also want the capsule frozen (board games, cutscenes).
     */
    hide(): void {
        this.setHideReason(RUNTIME_HIDE_REASON, true);
    }

    /**
     * Undo a previous `hide()`. Has no effect if `hide()` wasn't called.
     * Other reasons (e.g. first-person mode) can still keep the character
     * hidden.
     */
    show(): void {
        this.setHideReason(RUNTIME_HIDE_REASON, false);
    }

    /**
     * True iff a `hide()` call is currently in effect. Does NOT report
     * whether the character is invisible to the user — other reasons
     * (first-person mode, etc.) can hide it without `hide()` being called.
     * For "is anything rendering?" use `!isVisible()` (and remember that
     * body-part filters can still hide every visible part).
     */
    isManuallyHidden(): boolean {
        return this.hideReasons.has(RUNTIME_HIDE_REASON);
    }

    /**
     * Clear every hide reason, body-part contribution, and the manual
     * override. Should be called when transferring the visibility owner to a
     * new game (`GameEngine.loadGame`) so reasons from the previous game
     * don't leak into the next. Does NOT clear the registered roots —
     * `setSkeletonRoot` / `setBlockRoot` re-register those when the new
     * player loads.
     */
    reset(): void {
        this.hideReasons.clear();
        this.hiddenBodyPartsByReason.clear();
        this.manualOverride = null;
        this.apply();
    }

    // ─── Composable API ─────────────────────────────────────────────────────

    setSkeletonRoot(root: THREE.Object3D | null): void {
        this.skeletonRoot = root;
        this.apply();
    }

    setBlockRoot(root: THREE.Object3D | null): void {
        this.blockRoot = root;
        this.apply();
    }

    setHideReason(reason: string, hide: boolean): void {
        const had = this.hideReasons.has(reason);
        if (hide) {
            this.hideReasons.add(reason);
        } else {
            this.hideReasons.delete(reason);
        }
        if (had !== hide) {
            this.apply();
        }
    }

    hasHideReason(reason: string): boolean {
        return this.hideReasons.has(reason);
    }

    /**
     * Contribute (or clear) the body parts hidden for a named reason.
     *
     * Contributions union across reasons — if ANY reason marks a part hidden
     * (or any reason is `'all'`), the part is hidden. Pass `null` to remove
     * this reason's contribution entirely.
     */
    setHiddenBodyParts(reason: string, parts: BodyPartSelector): void {
        const before = this.hiddenBodyPartsByReason.get(reason);
        if (parts === null) {
            this.hiddenBodyPartsByReason.delete(reason);
        } else {
            this.hiddenBodyPartsByReason.set(reason, parts);
        }
        if (!shallowEqualSelector(before, parts ?? undefined)) {
            this.apply();
        }
    }

    /**
     * Force the character visible (true), hidden (false), or defer to the
     * hide-reason set (null). Overrides any pending hide reasons in either
     * direction — bypasses every hide reason from any subsystem.
     */
    setManualOverride(override: boolean | null): void {
        if (this.manualOverride === override) return;
        this.manualOverride = override;
        this.apply();
    }

    getManualOverride(): boolean | null {
        return this.manualOverride;
    }

    /**
     * True iff the character root is currently set to render — composes the
     * manual override with the hide-reason set. Ignores the body-part
     * filter (a `'all'` filter can still hide every visible part).
     */
    isVisible(): boolean {
        if (this.manualOverride !== null) return this.manualOverride;
        return this.hideReasons.size === 0;
    }

    private apply(): void {
        const rootVisible = this.isVisible();
        if (this.blockRoot) {
            this.blockRoot.visible = rootVisible;
            // Per-part visibility only matters when the root renders; skipping
            // when hidden avoids redundant writes during high-frequency
            // hide()/show() loops (e.g. i-frame blink).
            if (rootVisible) this.applyBodyPartFilter();
        }
        // The skeleton root follows the same state EVEN WHEN a block character
        // is the visible body — it is not an either/or with `blockRoot`:
        //
        //  1. It is the attachment container. `RangedWeaponSystem` parents guns
        //     to the player group rather than to a hand (the arms are posed onto
        //     the weapon's grips instead), and `visible = false` on a group culls
        //     its whole subtree. A hidden group therefore renders an equipped gun
        //     invisible while the block character itself draws normally.
        //  2. Writing only one root leaves the other holding a STALE value. The
        //     block root is registered after the character finishes loading, so
        //     any hide applied before that — e.g. the 'not-started' menu state,
        //     set in the PlayerController constructor — landed on the skeleton
        //     root and was never undone, because every later apply() took the
        //     block-root branch.
        //
        // Showing the group does not reveal the source glTF character: in
        // block-character mode PlayerLoader hides that child object itself.
        if (this.skeletonRoot) {
            this.skeletonRoot.visible = rootVisible;
        }
    }

    private applyBodyPartFilter(): void {
        if (!this.blockRoot) return;
        const hidden = this.computeHiddenParts();
        // Body parts are direct children of the block root, each is a
        // THREE.Group named for the part (see BlockCharacterRenderer.create).
        for (const child of this.blockRoot.children) {
            if (!child.name) continue;
            const isHidden = hidden === 'all' || hidden.has(child.name);
            child.visible = !isHidden;
        }
    }

    private computeHiddenParts(): Set<string> | 'all' {
        const hidden = new Set<string>();
        for (const parts of this.hiddenBodyPartsByReason.values()) {
            if (parts === 'all') return 'all';
            for (const p of parts) hidden.add(p);
        }
        return hidden;
    }
}

function shallowEqualSelector(
    a: string[] | 'all' | undefined,
    b: string[] | 'all' | undefined,
): boolean {
    if (a === b) return true;
    if (a === undefined || b === undefined) return false;
    if (a === 'all' || b === 'all') return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
