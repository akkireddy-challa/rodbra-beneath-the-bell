/**
 * A declarative spec for a mobile button, used by genres to declare
 * upfront which buttons they need. GameTemplate creates them before
 * game systems initialize, eliminating lazy-registration bugs.
 */
export interface MobileActionSpec {
    /** Unique action name (e.g. 'shoot', 'build', 'mine'). */
    action: string;
    /** Desktop keys that trigger this action (e.g. ['KeyF'] or ['Space']). */
    desktopKeys: string[];
    /** Icon key; looked up in MobileIconRegistry. If unknown, the label is used. */
    iconKey: string;
    /** Fallback label when icon lookup misses. Always provide. */
    label: string;
    /** Visible-on-start? Defaults to true. Some buttons (e.g. exit) are shown on-demand. */
    initiallyVisible?: boolean;
    /** 'tap' fires on release; 'continuous' fires every frame while held. */
    behavior: 'tap' | 'continuous';
    /** Slot hint — the layout manager prefers this slot if free. */
    preferredSlot?: MobileSlot;
}

export type MobileSlot =
    | 'primary'      // biggest action button, bottom-right inner
    | 'secondary'    // bottom-right outer
    | 'ascend'       // right column, above primary
    | 'descend'      // right column, below primary
    | 'left-1' | 'left-2' | 'left-3' // left-side auxiliary stack
    | 'top-left' | 'top-right';       // HUD corners

/**
 * An icon is either a short text label or a URL to a PNG/SVG. Consumers decide
 * how to render. Text labels (not emojis) are the default so button glyphs
 * inherit the active UI theme's font and color via the `.hud-mobile-button`
 * CSS — emojis render in their own fixed color/typeface and ignore the theme.
 */
export type MobileIcon = { kind: 'text'; value: string } | { kind: 'url'; value: string };

export class MobileIconRegistry {
    // Short, uppercase text labels keep buttons legible while inheriting the
    // theme font/case/tracking. Keep these terse (~3-5 chars) so they fit the
    // circular action buttons.
    private static readonly map = new Map<string, MobileIcon>([
        ['jump',       { kind: 'text', value: 'JUMP' }],
        ['crouch',     { kind: 'text', value: 'DUCK' }],
        ['interact',   { kind: 'text', value: 'USE' }],
        ['punch',      { kind: 'text', value: 'HIT' }],
        ['shoot',      { kind: 'text', value: 'FIRE' }],
        ['build',      { kind: 'text', value: 'BUILD' }],
        ['mine',       { kind: 'text', value: 'MINE' }],
        ['aim',        { kind: 'text', value: 'AIM' }],
        ['exit',       { kind: 'text', value: 'EXIT' }],
        // Dedicated keys per action type — keeps behavior explicit even when two
        // actions happen to share a label (e.g. melee + punch both read "HIT").
        ['melee',      { kind: 'text', value: 'HIT' }],
        ['projectile', { kind: 'text', value: 'FIRE' }],
        ['dance',      { kind: 'text', value: 'DANCE' }],
        ['magic',      { kind: 'text', value: 'MAGIC' }],
        ['pushup',     { kind: 'text', value: 'PUMP' }],
        ['block',      { kind: 'text', value: 'BLOCK' }],
        ['altfire',    { kind: 'text', value: 'ALT' }],
        ['special',    { kind: 'text', value: 'SPEC' }],
        ['reload',     { kind: 'text', value: 'LOAD' }],
    ]);

    static register(key: string, icon: MobileIcon): void {
        MobileIconRegistry.map.set(key, icon);
    }

    static get(key: string): MobileIcon | undefined {
        return MobileIconRegistry.map.get(key);
    }
}
