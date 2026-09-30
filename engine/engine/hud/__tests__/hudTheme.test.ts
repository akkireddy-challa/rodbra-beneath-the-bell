import {
    HUD_PRESETS,
    BITMAGIC_THEME,
    DEFAULT_HUD_THEME,
    RIFT_RAIDER_THEME,
    HUD_FONTS,
    HUD_DECORATIONS,
    validateAndResolveTheme,
    substituteThemeColors,
    buildGoogleFontsUrl,
    getFontCssStack,
    type FontKey,
    type DecorationKey,
    type HudElementClass,
} from 'engine/hud/index.js';

// Inline fixture (the retired 'horror' preset's data): a dark primary, a
// display font that only suits case 'normal', curated decorations and a
// per-element healthBar override — everything the resolver/manager tests need
// that the five shipped presets don't all exercise.
const DARK_FIXTURE = {
    name: 'Dark Fixture',
    font: { key: 'creepster', case: 'normal', weightBody: 400, weightHeading: 400, trackingLabel: 0.5 },
    colors: {
        primary: '#8B0000', danger: '#FF1A1A', warning: '#B8860B', success: '#4F7942',
        background: '#050505', surface: '#1A0808', text: '#E8E0D0', textMuted: '#807070',
    },
    shape: { radiusPill: 0, radiusCard: 0, glow: 'horror-red', imageRendering: 'auto' },
    decorations: {
        progressBar: { borderImage: 'drip-border' },
        toast: { borderImage: 'bracket-frame' },
        reticle: { decorationBefore: 'glow-aura' },
    },
    elements: {
        healthBar: { colors: { primary: '#C71010', danger: '#FF3030' }, shape: { glow: 'horror-red' } },
    },
} as const;
const darkResult = validateAndResolveTheme(DARK_FIXTURE);
if (!darkResult.ok) throw new Error('DARK_FIXTURE failed validation: ' + darkResult.errors.map(e => e.message).join('; '));
const DARK_THEME = darkResult.theme;

describe('HUD theme system', () => {
    describe('presets', () => {
        it('resolves the bitmagic preset cleanly', () => {
            expect(BITMAGIC_THEME.name).toBe('Bitmagic');
            expect(BITMAGIC_THEME.colors.primary).toBe('#A0DAB9');
            expect(BITMAGIC_THEME.font.key).toBe('red-hat-display');
            expect(BITMAGIC_THEME.shape.glow).toBe('aqua');
        });

        it('resolves an inline dark theme with decorations and a per-element override', () => {
            expect(DARK_THEME.name).toBe('Dark Fixture');
            expect(DARK_THEME.shape.radiusPill).toBe(0);
            expect(DARK_THEME.elements.healthBar?.colors?.primary).toBe('#C71010');
            // decoration slots survive resolution
            expect(DARK_THEME.decorations.progressBar?.borderImage).toBe('drip-border');
            expect(DARK_THEME.decorations.toast?.borderImage).toBe('bracket-frame');
        });

        it('bitmagic is the default/fallback, not a listed preset', async () => {
            const { resolveWorldTheme } = await import('engine/hud/resolveWorldTheme.js');
            expect(DEFAULT_HUD_THEME).toBe(BITMAGIC_THEME);
            expect(Object.keys(HUD_PRESETS)).not.toContain('bitmagic');
            expect(resolveWorldTheme(undefined)).toBe(DEFAULT_HUD_THEME);
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                // Legacy names fall back to the default (visually a no-op for 'bitmagic').
                expect(resolveWorldTheme('bitmagic')).toBe(DEFAULT_HUD_THEME);
                expect(resolveWorldTheme('horror')).toBe(DEFAULT_HUD_THEME);
                expect(warn).toHaveBeenCalledTimes(2);
            } finally {
                warn.mockRestore();
            }
        });

        it('warns and drops an invalid per-element override leaf instead of accepting or rejecting it', () => {
            // `elements.<class>.font/colors/shape` used to be raw casts, so
            // `background: "bright-green"` sailed through validation and became
            // broken CSS with no message anywhere. Warn-and-drop is deliberate:
            // an ERROR would reject the whole theme, and published games carry
            // frozen inline themes this validator must keep accepting. The one
            // bad leaf disappears; everything else in the override survives.
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#000000', danger: '#000000', background: '#000000',
                    surface: '#000000', text: '#000000',
                },
                shape: {},
                elements: {
                    healthBar: {
                        colors: { background: 'bright-green', danger: '#E2452F' },
                        shape: { radiusPill: 9999 },
                    },
                },
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const paths = result.warnings.map(w => w.path);
            expect(paths).toContain('elements.healthBar.colors.background');
            expect(paths).toContain('elements.healthBar.shape.radiusPill');
            const override = result.theme.elements.healthBar;
            expect(override?.colors?.background).toBeUndefined();
            expect(override?.colors?.danger).toBe('#E2452F');
            expect(override?.shape?.radiusPill).toBeUndefined();
        });

        it('the [HUD] console warnings carry the validator suggestions', async () => {
            // The suggestion field is the actionable half of every issue — the
            // closest-match name, the font-case remedy — and this console line
            // is the ONLY channel the CLI lane has: `bitmagic verify` parses it,
            // and there is no write tool there to return suggestions. It used to
            // format `path: message` and throw the hint away at the last hop.
            const { resolveWorldTheme } = await import('engine/hud/resolveWorldTheme.js');
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                // The unhyphenated internal style key — the documented trap.
                resolveWorldTheme('riftraider');
                const presetLine = warn.mock.calls[0]?.join(' ') ?? '';
                expect(presetLine).toContain('Unknown theme preset');
                expect(presetLine).toContain('Closest match: "rift-raider"');

                warn.mockClear();
                resolveWorldTheme({
                    name: 'X',
                    font: { key: 'orbitorn' },
                    colors: {
                        primary: '#000000', danger: '#000000', background: '#000000',
                        surface: '#000000', text: '#000000',
                    },
                    shape: {},
                });
                const customLine = warn.mock.calls[0]?.join(' ') ?? '';
                expect(customLine).toContain('Custom theme failed validation');
                expect(customLine).toContain('(Closest match: "orbitron")');
            } finally {
                warn.mockRestore();
            }
        });

        it('validates the gloss and glowColor tokens', () => {
            const theme = (shape: Record<string, unknown>): Record<string, unknown> => ({
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#000000', danger: '#000000', background: '#000000',
                    surface: '#000000', text: '#000000',
                },
                shape,
            });
            const ok = validateAndResolveTheme(theme({ gloss: 0.5, glowColor: '#AA22FF' }));
            expect(ok.ok).toBe(true);
            if (!ok.ok) return;
            expect(ok.theme.shape.gloss).toBe(0.5);
            expect(ok.theme.shape.glowColor).toBe('#AA22FF');

            // Absent stays absent: gloss defaults to 0, glowColor to no key at all.
            const bare = validateAndResolveTheme(theme({}));
            expect(bare.ok).toBe(true);
            if (!bare.ok) return;
            expect(bare.theme.shape.gloss).toBe(0);
            expect('glowColor' in bare.theme.shape).toBe(false);

            const bad = validateAndResolveTheme(theme({ gloss: 2, glowColor: 'purple' }));
            expect(bad.ok).toBe(false);
            if (bad.ok) return;
            expect(bad.errors.map(e => e.path)).toEqual(
                expect.arrayContaining(['shape.gloss', 'shape.glowColor']),
            );
        });

        it('accepts a mobileControls per-element override', () => {
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#000000', danger: '#000000', background: '#000000',
                    surface: '#000000', text: '#000000',
                },
                shape: {},
                elements: { mobileControls: { colors: { primary: '#FF8800' } } },
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.theme.elements.mobileControls?.colors?.primary).toBe('#FF8800');
        });

        it('per-element gloss and glowColor survive resolution', () => {
            // checkPartialShape used to copy only the pre-5.x shape fields, so a
            // "glossy mobile buttons" override validated at write time, validated
            // at load time, and was stripped without even a warning between the
            // two — the quietest possible failure, invisible to the parity gate
            // because both validators said ok.
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#000000', danger: '#000000', background: '#000000',
                    surface: '#000000', text: '#ffffff',
                },
                shape: {},
                elements: { mobileControls: { shape: { gloss: 0.8, glowColor: '#B44BFF' } } },
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const shape = result.theme.elements.mobileControls?.shape;
            expect(shape?.gloss).toBe(0.8);
            expect(shape?.glowColor).toBe('#B44BFF');
        });

        it('colorMath pins the values the derived-ink comments cite', async () => {
            // These exact numbers appear in ThemeManager's derivation comments and
            // in the agent-side mirrors; if the arithmetic drifts, the prose lies.
            const m = await import('engine/hud/colorMath.js');
            expect(m.contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
            expect(m.contrastRatio('#FFFFFF', '#6E5C44')).toBeCloseTo(6.41, 2);
            expect(m.readableTextColor('#9BDB4F')).toBe('#000000');
            expect(m.readableTextColor('#463A2B')).toBe('#ffffff');
            expect(m.inkOnSurface('#6E5C44', '#413A2C')).toBe('#ffffff');
            expect(m.inkOnSurface('#0A121A', '#E6F6FA')).toBe('#E6F6FA');
            expect(m.accentInkOn('#04070C', '#4FD8E8')).toBeNull();
            expect(m.accentInkOn('#E9E1CE', '#9BDB4F')).toBe('#4d6d27');
            expect(m.ON_SURFACE_MIN_CONTRAST).toBe(3);
            expect(m.ACCENT_INK_MIN_CONTRAST).toBe(4.5);
        });

        it('exposes all presets in HUD_PRESETS', () => {
            expect(Object.keys(HUD_PRESETS).sort()).toEqual([
                'nexus',
                'racing',
                'rift-raider',
                'simulator',
                'village-keep',
            ]);
        });

        it('every preset round-trips through validateAndResolveTheme with zero errors', () => {
            for (const [name, theme] of Object.entries(HUD_PRESETS)) {
                const result = validateAndResolveTheme(theme);
                expect({ name, ok: result.ok }).toEqual({ name, ok: true });
                if (!result.ok) continue;
                expect({ name, errors: [] }).toEqual({ name, errors: [] });
            }
        });

        it('resolves rift-raider with the outline/border/bevel tokens', () => {
            const theme = HUD_PRESETS['rift-raider'];
            expect(theme.colors.outline).toBe('#5A3D0C');
            expect(theme.shape.borderWidth).toBe(2);
            expect(theme.shape.bevel).toBeCloseTo(0.85);
            expect(theme.font.outlineWidth).toBe(2);
            expect(theme.shape.glow).toBe('gold');
        });

        it('the flat styles bloom nowhere and never outline type', () => {
            // `bevel` is deliberately NOT asserted to be 0 any more: it paints the
            // button/counter/bar gradient, and these styles are flat PLATES with
            // pressable CONTROLS — panels are surfaces, buttons are objects.
            // What still defines them is that nothing glows and no type is stroked.
            // Nexus is NOT in this list on purpose — glow is its whole identity.
            for (const name of ['simulator', 'racing'] as const) {
                const theme = HUD_PRESETS[name];
                expect({ name, glow: theme.shape.glow }).toEqual({ name, glow: 'none' });
                expect({ name, stroke: theme.font.outlineWidth }).toEqual({ name, stroke: 0 });
            }
        });

        it('presets whose controls are physical give their buttons a rim', () => {
            // The complaint that produced this: buttons that were a 1px outline on
            // a flat fill read as web chrome, not as game controls.
            //
            // `simulator` is NOT in this list, on the same principle that keeps
            // Nexus out of the no-glow list above: its reference is a screen UI
            // rather than a physical fascia, and across that whole UI there is
            // not one moulded control. A rim there would be the defect, not the
            // fix — so the contract is asserted per style, not globally.
            for (const name of ['rift-raider', 'village-keep', 'nexus', 'racing'] as const) {
                const theme = HUD_PRESETS[name];
                expect({ name, border: theme.shape.borderWidth >= 2 }).toEqual({ name, border: true });
                expect({ name, bevel: theme.shape.bevel > 0 }).toEqual({ name, bevel: true });
            }
        });

        it('simulator is contoured, not moulded', () => {
            // The other half of the contract above. This preset departs from its
            // own reference — which has no gradient at all — because dead flat
            // read as underdrawn: it carries a modest bevel for the fill and edge
            // gradient. What it must NOT pick up is the physical rim of the four
            // styles whose references are objects, so the border stays a
            // hairline and the bevel stays well below theirs (0.45-0.9).
            const sim = HUD_PRESETS.simulator;
            expect(sim.shape.borderWidth).toBe(1);
            expect(sim.shape.bevel).toBeGreaterThan(0);
            expect(sim.shape.bevel).toBeLessThan(0.45);
        });

        it('presets without new tokens resolve them to the defaults', () => {
            expect(BITMAGIC_THEME.shape.borderWidth).toBe(0);
            expect(BITMAGIC_THEME.shape.bevel).toBe(0);
            expect(BITMAGIC_THEME.font.outlineWidth).toBe(0);
            expect(BITMAGIC_THEME.colors.outline).toBeUndefined();
        });

        it('every preset carries an evokes line for the agent catalogue', async () => {
            // The field an AI picks a preset BY. It lived only in the agent-side mirror, outside
            // the drift gate, and went stale for three of five presets while the styles were
            // being retuned — so it lives beside the tokens now and is checked both ends.
            const raw = await Promise.all([
                import('engine/hud/themes/rift-raider.js').then(m => m.RIFT_RAIDER_THEME_DATA),
                import('engine/hud/themes/village-keep.js').then(m => m.VILLAGE_KEEP_THEME_DATA),
                import('engine/hud/themes/nexus.js').then(m => m.NEXUS_THEME_DATA),
                import('engine/hud/themes/simulator.js').then(m => m.SIMULATOR_THEME_DATA),
                import('engine/hud/themes/racing.js').then(m => m.RACING_THEME_DATA),
            ]);
            for (const data of raw) {
                const evokes = (data as { evokes?: string }).evokes;
                expect({ name: data.name, hasEvokes: typeof evokes === 'string' && evokes.length > 20 })
                    .toEqual({ name: data.name, hasEvokes: true });
            }
        });

        it('evokes never reaches ThemeTokens', () => {
            // It is authoring metadata, not a rendering token: the validator must keep dropping it
            // so it cannot be mistaken for something the HUD reads.
            for (const [name, theme] of Object.entries(HUD_PRESETS)) {
                expect({ name, leaked: 'evokes' in theme }).toEqual({ name, leaked: false });
            }
        });

        it('no two presets share a font', () => {
            const fontKeys = Object.values(HUD_PRESETS).map(t => t.font.key);
            expect(new Set(fontKeys).size).toBe(fontKeys.length);
        });
    });

    describe('validateAndResolveTheme', () => {
        it('suggests a close match for a typo, and stays silent for a wild guess', () => {
            // Both halves matter. The old scorer counted character containment,
            // so it ALWAYS suggested something — "wingdings" got a confident
            // "Closest match" pointing at an arbitrary catalog font, which an
            // agent then copies. Levenshtein with a distance cap keeps the hint
            // for what a typo actually is and drops it where the right answer
            // is the full catalog list in the error message.
            const themeWithFont = (key: string): Record<string, unknown> => ({
                name: 'X',
                font: { key },
                colors: {
                    primary: '#000000',
                    danger: '#000000',
                    background: '#000000',
                    surface: '#000000',
                    text: '#000000',
                },
                shape: {},
            });

            const typo = validateAndResolveTheme(themeWithFont('orbitorn'));
            expect(typo.ok).toBe(false);
            if (typo.ok) return;
            const typoErr = typo.errors.find(e => e.path === 'font.key');
            expect(typoErr?.suggestion).toContain('"orbitron"');

            const wild = validateAndResolveTheme(themeWithFont('wingdings'));
            expect(wild.ok).toBe(false);
            if (wild.ok) return;
            const wildErr = wild.errors.find(e => e.path === 'font.key');
            expect(wildErr).toBeDefined();
            expect(wildErr?.suggestion).toBeUndefined();
        });

        it('rejects malformed hex colors', () => {
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#GGG',
                    danger: '#000000',
                    background: '#000000',
                    surface: '#000000',
                    text: '#000000',
                },
                shape: {},
            });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.errors.some(e => e.path === 'colors.primary')).toBe(true);
        });

        it('rejects out-of-range radiusPill', () => {
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#000000',
                    danger: '#000000',
                    background: '#000000',
                    surface: '#000000',
                    text: '#000000',
                },
                shape: { radiusPill: 999 },
            });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.errors.some(e => e.path === 'shape.radiusPill')).toBe(true);
        });

        it('rejects decoration in unknown HUD element class', () => {
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#000000',
                    danger: '#000000',
                    background: '#000000',
                    surface: '#000000',
                    text: '#000000',
                },
                shape: {},
                decorations: { fishHat: { borderImage: 'drip-border' } },
            });
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.errors.some(e => e.path === 'decorations.fishHat')).toBe(true);
        });

        it('warns (but accepts) decoration in unsuited slot', () => {
            // scanline is designed for backdrop, not borderImage
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#000000',
                    danger: '#000000',
                    background: '#000000',
                    surface: '#000000',
                    text: '#000000',
                },
                shape: {},
                decorations: { progressBar: { borderImage: 'scanline' } },
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.warnings.length).toBeGreaterThan(0);
            expect(
                result.warnings.some(w => w.path === 'decorations.progressBar.borderImage'),
            ).toBe(true);
        });

        it('warns when a display font uses case "upper"', () => {
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'creepster', case: 'upper' },
                colors: {
                    primary: '#000000',
                    danger: '#000000',
                    background: '#000000',
                    surface: '#000000',
                    text: '#000000',
                },
                shape: {},
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.warnings.some(w => w.path === 'font.case')).toBe(true);
        });

        it('validates the new token ranges', () => {
            const base = {
                name: 'X',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#000000',
                    danger: '#000000',
                    background: '#000000',
                    surface: '#000000',
                    text: '#000000',
                },
            };
            const borderTooWide = validateAndResolveTheme({ ...base, shape: { borderWidth: 7 } });
            expect(borderTooWide.ok).toBe(false);
            if (!borderTooWide.ok) {
                expect(borderTooWide.errors.some(e => e.path === 'shape.borderWidth')).toBe(true);
            }

            const bevelTooStrong = validateAndResolveTheme({ ...base, shape: { bevel: 2 } });
            expect(bevelTooStrong.ok).toBe(false);
            if (!bevelTooStrong.ok) {
                expect(bevelTooStrong.errors.some(e => e.path === 'shape.bevel')).toBe(true);
            }

            const outlineTooWide = validateAndResolveTheme({
                ...base,
                font: { key: 'red-hat-display', outlineWidth: 4 },
                shape: {},
            });
            expect(outlineTooWide.ok).toBe(false);
            if (!outlineTooWide.ok) {
                expect(outlineTooWide.errors.some(e => e.path === 'font.outlineWidth')).toBe(true);
            }

            const badOutlineColor = validateAndResolveTheme({
                ...base,
                colors: { ...base.colors, outline: 'navy' },
                shape: {},
            });
            expect(badOutlineColor.ok).toBe(false);
            if (!badOutlineColor.ok) {
                expect(badOutlineColor.errors.some(e => e.path === 'colors.outline')).toBe(true);
            }

            const goldGlow = validateAndResolveTheme({ ...base, shape: { glow: 'gold', borderWidth: 6, bevel: 1 } });
            expect(goldGlow.ok).toBe(true);
            if (goldGlow.ok) {
                expect(goldGlow.theme.shape.glow).toBe('gold');
                expect(goldGlow.theme.shape.borderWidth).toBe(6);
                expect(goldGlow.theme.shape.bevel).toBe(1);
            }
        });

        it('auto-corrects font.case when font does not support requested case', () => {
            const result = validateAndResolveTheme({
                name: 'X',
                font: { key: 'pacifico', case: 'upper' },
                colors: {
                    primary: '#000000',
                    danger: '#000000',
                    background: '#000000',
                    surface: '#000000',
                    text: '#000000',
                },
                shape: {},
            });
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            // Resolved theme uses the corrected case, not the input's "upper"
            expect(result.theme.font.case).toBe('normal');
            // A warning explains the swap
            const warning = result.warnings.find(w => w.path === 'font.case');
            expect(warning).toBeDefined();
            expect(warning?.message).toContain('auto-corrected');
        });
    });

    describe('catalog consistency', () => {
        it('every FontKey has a catalog entry', () => {
            const keys: ReadonlyArray<FontKey> = [
                'red-hat-display',
                'bebas-neue',
                'press-start-2p',
                'creepster',
                'pacifico',
                'space-grotesk',
                'rubik-mono-one',
                'vt323',
                'orbitron',
                'shrikhand',
                'lilita-one',
                'fredoka',
                'grenze-gotisch',
                'cinzel',
            ];
            for (const k of keys) {
                expect(HUD_FONTS[k]).toBeDefined();
                expect(HUD_FONTS[k].key).toBe(k);
                expect(HUD_FONTS[k].family.length).toBeGreaterThan(0);
                expect(HUD_FONTS[k].weights.length).toBeGreaterThan(0);
            }
        });

        it('every DecorationKey has a catalog entry with at least one suited slot', () => {
            const keys: ReadonlyArray<DecorationKey> = [
                'drip-border',
                'pixel-corners',
                'scanline',
                'vine-corner',
                'glow-aura',
                'bracket-frame',
                'ribbon-edge',
                'circuit-trace',
                'candy-gloss',
                'ornate-corner',
                'royal-frame',
                'hazard-stripes',
                'pixel-frame',
                'grain-texture',
            ];
            for (const k of keys) {
                expect(HUD_DECORATIONS[k]).toBeDefined();
                expect(HUD_DECORATIONS[k].suitsSlots.length).toBeGreaterThan(0);
                expect(HUD_DECORATIONS[k].svg.length).toBeLessThan(800);
            }
        });

        it('an inline decoration may state a tile size, but not arbitrary CSS', () => {
            // Without the explicit form a hand-authored TILING texture cannot be
            // expressed at all: every one of these SVGs is viewBox-only, so all
            // three keywords stretch a single copy over the element.
            //
            // The value is interpolated straight into `background-size:`, so the
            // accepted string form is two plain lengths and nothing else — the
            // rejections below are the point of the check, not a formality.
            const withSize = (size: string): boolean => validateAndResolveTheme({
                name: 'T',
                font: { key: 'orbitron' },
                colors: {
                    primary: '#111111', danger: '#111111', background: '#111111',
                    surface: '#111111', text: '#eeeeee',
                },
                shape: {},
                decorations: {
                    toast: { backdrop: { svg: '<svg viewBox="0 0 8 8"/>', size, repeat: 'repeat' } },
                },
            }).ok;

            for (const good of ['32px 32px', '100% 12px', '60px 100%', 'cover', 'contain', 'auto']) {
                expect({ size: good, accepted: withSize(good) }).toEqual({ size: good, accepted: true });
            }
            for (const bad of [
                'red; background-image: url(evil)',
                'calc(100% - 4px) 8px',
                'var(--x) 8px',
                '32px',
                '32em 32em',
                '',
            ]) {
                expect({ size: bad, accepted: withSize(bad) }).toEqual({ size: bad, accepted: false });
            }
        });

        it('a tiling decoration states its tile size', () => {
            // An inline SVG carrying only a `viewBox` has no intrinsic size, so
            // `background-size: auto` does NOT mean "one tile at the viewBox
            // size" — the browser scales a single copy to fill the element. A
            // pattern meant to repeat then renders as one enormous motif.
            //
            // That shipped: `circuit-trace` drew a handful of giant crosshairs
            // across the controls overlay instead of a fine circuit texture, and
            // it took a bug report to notice. The rule is mechanical, so check it
            // mechanically — and only where it matters, on the slots that
            // actually paint a background.
            const paints = (k: DecorationKey): boolean =>
                HUD_DECORATIONS[k].suitsSlots.some(
                    s => s === 'backdrop' || s === 'decorationBefore' || s === 'decorationAfter',
                );
            for (const key of Object.keys(HUD_DECORATIONS) as DecorationKey[]) {
                const entry = HUD_DECORATIONS[key];
                const repeats = entry.background?.repeat !== undefined
                    && entry.background.repeat !== 'no-repeat';
                if (!repeats || !paints(key)) continue;
                const size = entry.background?.size;
                const sized = typeof size === 'string' && size !== 'auto';
                const hasIntrinsic = /<svg[^>]*\swidth=/.test(entry.svg);
                expect({ key, tileSized: sized || hasIntrinsic }).toEqual({ key, tileSized: true });
            }
        });

        it('a decoration built to STRETCH is not sized by its aspect ratio', () => {
            // The mirror image of the rule above, and the second time this class of
            // bug reached a player. `preserveAspectRatio="none"` on the SVG means
            // "I am built to be stretched to whatever box you hand me". `cover`,
            // `contain` and `auto` all do the opposite — they honour the viewBox's
            // intrinsic ratio and scale the image until it satisfies that ratio.
            //
            // `candy-gloss` shipped preserveAspectRatio="none" paired with `cover`.
            // Its viewBox is 100:40, so on a CONTROLS panel (~180 wide, ~220 tall)
            // the browser scaled the image to 550x220 and centred it: what reached
            // the screen was the middle of a hugely magnified ellipse — a grey blob
            // across the top third of the panel. It looked passable on wide, short
            // toasts, which is exactly why it survived review.
            //
            // The tiling rule above could not catch it: that one only inspects
            // decorations whose `repeat` is not `no-repeat`.
            const paints = (k: DecorationKey): boolean =>
                HUD_DECORATIONS[k].suitsSlots.some(
                    s => s === 'backdrop' || s === 'decorationBefore' || s === 'decorationAfter',
                );
            for (const key of Object.keys(HUD_DECORATIONS) as DecorationKey[]) {
                const entry = HUD_DECORATIONS[key];
                if (!paints(key) || !/preserveAspectRatio\s*=\s*"none"/.test(entry.svg)) continue;
                const size = entry.background?.size ?? 'auto';
                const ratioSized = size === 'auto' || size === 'cover' || size === 'contain';
                expect({ key, ratioSized }).toEqual({ key, ratioSized: false });
            }
        });
    });

    describe('substituteThemeColors', () => {
        it('replaces __primary__ token with the active theme color', () => {
            const svg = '<svg fill="__primary__"/>';
            const out = substituteThemeColors(svg, BITMAGIC_THEME.colors);
            expect(out).toBe('<svg fill="#A0DAB9"/>');
        });

        it('leaves unknown __token__ strings untouched', () => {
            const svg = '<svg data-x="__unknown__" fill="__danger__"/>';
            const out = substituteThemeColors(svg, BITMAGIC_THEME.colors);
            expect(out).toContain('__unknown__');
            expect(out).toContain('#E0218A');
        });
    });

    describe('buildGoogleFontsUrl', () => {
        it('builds a Google Fonts URL filtered to a single font with the requested weights', () => {
            const url = buildGoogleFontsUrl('red-hat-display', [400, 700]);
            expect(url).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=Red\+Hat\+Display/);
            expect(url).toContain(':wght@400;700');
            expect(url).toContain('display=swap');
        });

        it('falls back to the font catalog weights if none of the requested weights are valid', () => {
            const url = buildGoogleFontsUrl('creepster', [999]);
            expect(url).toContain(':wght@400');
        });
    });

    describe('getFontCssStack', () => {
        it('quotes the family and appends a fallback stack', () => {
            const stack = getFontCssStack('press-start-2p');
            expect(stack).toContain('"Press Start 2P"');
            expect(stack).toContain('Helvetica');
        });
    });

    describe('ThemeManager (with DOM stub)', () => {
        // We don't want to add jest-environment-jsdom just for this test, so we
        // stub the minimum DOM surface ThemeManager touches. If the manager grows
        // new DOM dependencies, the stub fails fast.
        let originalDocument: typeof document | undefined;
        let documentElement!: ReturnType<typeof makeStubElement>;

        beforeAll(() => {
            originalDocument = (globalThis as { document?: Document }).document;
            const head = makeStubElement();
            documentElement = makeStubElement('html');
            const stubDocument = {
                head,
                documentElement,
                getElementById: (_id: string): HTMLElement | null => null,
                createElement: (tag: string): HTMLElement => makeStubElement(tag) as unknown as HTMLElement,
            };
            (globalThis as { document?: unknown }).document = stubDocument;
        });

        afterAll(() => {
            (globalThis as { document?: unknown }).document = originalDocument;
        });

        it('sets --hud-* custom properties on documentElement and creates a font link', async () => {
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });
            mgr.applyTheme(BITMAGIC_THEME);

            // Tokens cascade globally — set on documentElement, not the HUD root.
            expect(documentElement.styleProps.get('--hud-color-primary')).toBe('#A0DAB9');
            expect(documentElement.styleProps.get('--hud-color-on-primary')).toBe('#000000'); // light primary → black text
            expect(documentElement.styleProps.get('--hud-font-family')).toContain('Red Hat Display');
            expect(documentElement.styleProps.get('--hud-radius-pill')).toBe('500px');
            expect(documentElement.styleProps.get('--hud-glow-color')).toContain('rgba(160, 218, 185');

            // Per-HUD-root scoping: the data-hud-theme attribute lets per-theme rules target the right HUD.
            expect(root.datasetStore.hudTheme).toBe('bitmagic');

            // Decoration <style> still scoped to the HUD root, not documentElement.
            expect(root.children.some(c => c.tagName === 'STYLE')).toBe(true);
        });

        it('both decoration strips span the full width of the element they hang off', async () => {
            // `inset` is top/right/bottom/left. `decorationBefore` shipped as
            // `auto auto 100% 0`, which leaves RIGHT at `auto` — and an absolutely
            // positioned box with one horizontal side auto shrink-to-fits its own
            // content, which for `content: ""` is nothing. Measured in a browser it
            // came out 0px x 12px, against decorationAfter's 93.7px x 12px.
            //
            // So no `decorationBefore` had ever drawn a pixel, in any theme, since
            // the slot was introduced — including the aura Nexus hangs off its
            // reticle. Nothing failed and nothing logged; the slot simply did not
            // exist in practice. Assert the geometry, because that is the part a
            // screenshot of a working theme cannot tell you.
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });
            // DARK_THEME puts glow-aura in the reticle's `decorationBefore` slot.
            mgr.applyTheme(DARK_THEME);

            const styleEl = root.children.find(c => c.tagName === 'STYLE');
            const css = styleEl?.textContent ?? '';
            const insets = [...css.matchAll(/\.hud-\w[\w-]*::(before|after)\s*\{([^}]*)\}/g)]
                .map(m => ({ pseudo: m[1], inset: /inset:\s*([^;]+);/.exec(m[2])?.[1]?.trim() }));

            expect(insets.length).toBeGreaterThan(0);
            for (const { pseudo, inset } of insets) {
                // Both horizontal sides pinned: second and fourth values are lengths.
                const sides = (inset ?? '').split(/\s+/);
                expect({ pseudo, right: sides[1], left: sides[3] })
                    .toEqual({ pseudo, right: '0', left: '0' });
            }
        });

        it('stamps an intrinsic size onto a border-image SVG so its slice means viewBox units', async () => {
            // A numeric `border-image-slice` is resolved against the RENDERED image.
            // An SVG carrying only a viewBox has no intrinsic size, so the browser
            // renders it at the border-image area — the ELEMENT — and the slice cuts
            // a fraction of the element instead of the artwork. Measured in Chromium
            // with a 12-unit viewBox and `slice: 4`: the corner piece paints 72px on
            // a 240px-wide element and 177px on a 600px one, where the author wrote
            // 4. Adding width/height makes it paint exactly 4px at both widths.
            //
            // Every borderSlice in the catalog is authored in viewBox units, so this
            // is what makes `drip-border`'s drips a row of drips rather than three
            // giant scallops, and what lets `pixel-frame` show its inner ring at all.
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });
            // DARK_THEME puts drip-border (viewBox 0 0 60 60) on the progress bar.
            mgr.applyTheme(DARK_THEME);

            const css = root.children.find(c => c.tagName === 'STYLE')?.textContent ?? '';
            const borderImage = /border-image:\s*url\("([^"]+)"\)/.exec(css);
            expect(borderImage).not.toBeNull();
            const svg = decodeURIComponent(borderImage![1].replace(/^data:image\/svg\+xml;utf8,/, ''));
            expect(svg).toMatch(/^<svg[^>]*\swidth="60"[^>]*>/);
            expect(svg).toMatch(/^<svg[^>]*\sheight="60"[^>]*>/);
        });

        it('emits real CSS for the hyphenated corner anchors, and a containing block for the strips', async () => {
            // Two separate silent failures, both in the background slots.
            //
            // `background-position` has no hyphenated corner keywords: Chromium
            // computes `bottom-left` as `0% 0%` and `bottom left` as `0% 100%`. The
            // invalid one drops the whole declaration, so four of the nine anchors
            // the schema and the validator advertise pinned the image to the OPPOSITE
            // corner. The hyphenated spellings stay in the vocabulary — they are in
            // the published schema and in shipped world.json files — so they are
            // translated at emission instead.
            //
            // And the ::before/::after strips are absolutely positioned, while every
            // element the decoration system can target computes to `position: static`
            // in the base sheet. Without an explicit containing block they resolve
            // against `.hud-root`, which is fixed and viewport-sized, and land off
            // the edge of the screen.
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });
            mgr.applyTheme({
                ...DARK_THEME,
                decorations: {
                    counter: { backdrop: { svg: '<svg viewBox="0 0 4 4"></svg>', size: 'auto', position: 'bottom-left', repeat: 'no-repeat' } },
                    toast: { decorationAfter: 'ribbon-edge' },
                },
            } as unknown as typeof DARK_THEME);

            const css = root.children.find(c => c.tagName === 'STYLE')?.textContent ?? '';
            expect(css).toContain('background-position: left bottom;');
            expect(css).not.toContain('bottom-left');
            expect(css).toMatch(/\.hud-toast \{ position: relative; \}/);
        });

        it('derives an on-surface ink that leaves every shipped preset exactly as it was', async () => {
            // `--hud-color-on-surface` exists because `text` carries two jobs that
            // only agree on a uniformly dark theme: ink on the `background` canvas
            // (which a game's own dialogs paint themselves with) and ink on every
            // element filled with `surface`. A style whose big UI is a light ground
            // and whose HUD furniture is darker cannot serve both from one value.
            //
            // The token is only useful if it is INERT for themes that were already
            // coherent — otherwise adding it would restyle five presets to fix one.
            // It prefers the theme's own ink and substitutes only below 3:1, and
            // every preset measures 9.6-17.8 for `text` and 5.7-9.3 for `textMuted`.
            // Assert the identity directly: if these hold, every rule repointed at
            // the new token computes exactly the value it computed before.
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            // Every shipped preset, plus the default — village-keep excluded because
            // it is the one theme this token exists to serve, and the test below
            // covers it.
            const themes = [BITMAGIC_THEME, DEFAULT_HUD_THEME,
                ...Object.entries(HUD_PRESETS).filter(([k]) => k !== 'village-keep').map(([, v]) => v)];
            for (const theme of themes) {
                const root = makeStubElement();
                new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true }).applyTheme(theme);
                expect({
                    name: theme.name,
                    onSurface: documentElement.styleProps.get('--hud-color-on-surface'),
                    onSurfaceMuted: documentElement.styleProps.get('--hud-color-on-surface-muted'),
                }).toEqual({
                    name: theme.name,
                    onSurface: theme.colors.text,
                    onSurfaceMuted: theme.colors.textMuted,
                });
            }
        });

        it('substitutes a readable ink when a theme lights its canvas and darkens its furniture', async () => {
            // The case the token was added for, and the one no other preset exercises:
            // dark ink fitted to a light `background`, over a much darker `surface`.
            // 1.76:1 as declared, so both inks are replaced — the full one outright,
            // the muted one with a value that steps back toward its own backdrop
            // instead of becoming the loudest thing on the element.
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true }).applyTheme({
                ...DARK_THEME,
                colors: { ...DARK_THEME.colors, background: '#E9E1CE', surface: '#6E5C44', text: '#413A2C', textMuted: '#585040' },
            } as unknown as typeof DARK_THEME);

            expect(documentElement.styleProps.get('--hud-color-on-surface')).toBe('#ffffff');
            const muted = documentElement.styleProps.get('--hud-color-on-surface-muted') ?? '';
            expect(muted).not.toBe('#585040');
            expect(muted).not.toBe('#ffffff');
        });

        it('leaves accent type on its accent unless the accent cannot be read on the ground', async () => {
            // Accent-coloured type — a modal title, a lobby heading, a status line —
            // works outright on every dark-grounded preset: 6.0 to 16.9:1. So the
            // token must stay ABSENT there, and while it is absent every consumer
            // falls through its var() chain to the colour it used before this token
            // existed. That is the whole safety property.
            //
            // It cannot be fixed by picking a better accent: on village-keep a value
            // readable on the parchment ground needs L <= 0.217 and one readable on
            // the mid-brown furniture needs L >= 0.442, and those do not overlap.
            // Where it does fire, it walks the accent toward the ground's opposite
            // pole and stops at the first value that clears — so the result keeps the
            // accent's HUE, which is the part that makes an accent an accent. Candy
            // lime lands on a forest green, not on brown.
            const lum = (hex: string): number => {
                const c = [1, 3, 5].map(i => {
                    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
                    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
                });
                return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
            };
            const ratio = (a: string, b: string): number =>
                (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const check = (raw: string, derived: string | undefined, ground: string, hue: 0 | 1): void => {
                if (ratio(raw, ground) >= 4.5) {
                    // Already readable, so the token stays absent and every consumer
                    // falls through its var() chain to the raw accent.
                    expect(derived).toBeUndefined();
                    return;
                }
                expect(derived).toBeDefined();
                expect(ratio(derived as string, ground)).toBeGreaterThanOrEqual(4.5);
                // Hue kept: the accent's dominant channel is still dominant.
                const ch = [1, 3, 5].map(i => parseInt((derived as string).slice(i, i + 2), 16));
                expect(ch[hue]).toBeGreaterThan(Math.max(...ch.filter((_, i) => i !== hue)));
            };

            for (const theme of Object.values(HUD_PRESETS)) {
                const root = makeStubElement();
                new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true }).applyTheme(theme);
                // primary is green on village-keep, red-dominant nowhere; danger is
                // red-dominant on every preset that has one.
                check(theme.colors.primary, documentElement.styleProps.get('--hud-color-accent-ink'),
                    theme.colors.background, 1);
                check(theme.colors.danger, documentElement.styleProps.get('--hud-color-danger-ink'),
                    theme.colors.background, 0);
            }
        });

        it('delivers a mobileControls override as scoped CSS in the decoration stylesheet', async () => {
            // Every other element class gets its override vars set per-node by
            // GameHUD's factory — but the mobile controls attach themselves to
            // document.body from MobileControls, so the factory never sees them.
            // Their override rides the decoration <style> as a rule scoped to
            // .hud-mobile-controls instead; custom properties cascade identically.
            // Without this delivery the ninth element class would validate, apply,
            // and change nothing on screen.
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });
            mgr.applyTheme({
                ...DARK_THEME,
                elements: {
                    mobileControls: {
                        // font was a dead knob: validated on both sides, advertised
                        // in the schema, read by nothing. It now emits the same
                        // variables the document-level font block sets.
                        font: { sizeScale: 1.2 },
                        colors: { primary: '#FF8800', text: '#FFE8D0' },
                        shape: null,
                        decorations: null,
                    },
                },
            });

            const css = root.children.find(c => c.tagName === 'STYLE')?.textContent ?? '';
            const rule = /\.hud-mobile-controls \{[^}]*\}/.exec(css)?.[0] ?? '';
            expect(rule).toContain('--hud-color-primary: #FF8800;');
            expect(rule).toContain('--hud-color-text: #FFE8D0;');
            // The fill label re-derives per element rather than keeping the
            // theme-wide derivation. For #FF8800 that is WHITE — readableTextColor
            // cuts at luminance 0.5, and strong orange sits just under it. That
            // pairing lands at 2.4:1, which is exactly what the write report's
            // `button label ... LOW` line exists to surface; the test pins the
            // real derivation, not the wished-for one.
            expect(rule).toContain('--hud-color-on-primary: #ffffff;');
            // ...and the on-surface ink re-derives from the overridden text.
            expect(rule).toContain('--hud-color-on-surface: #FFE8D0;');
            expect(rule).toContain('--hud-font-scale: 1.2;');
        });

        it('derives white on-primary for dark themes', async () => {
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });
            mgr.applyTheme(DARK_THEME);
            // The fixture's primary #8B0000 is dark → on-primary should be white.
            expect(documentElement.styleProps.get('--hud-color-on-primary')).toBe('#ffffff');
        });

        it('sets the conditional tokens for themes that define them, and removes them again', async () => {
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });

            mgr.applyTheme(RIFT_RAIDER_THEME);
            expect(documentElement.styleProps.get('--hud-color-outline')).toBe('#5A3D0C');
            expect(documentElement.styleProps.get('--hud-border-width')).toBe('2px');
            expect(documentElement.styleProps.get('--hud-text-outline-width')).toBe('2px');
            expect(documentElement.styleProps.get('--hud-bevel-top')).toContain('rgba(255, 255, 255');
            expect(documentElement.styleProps.get('--hud-bevel-bottom')).toContain('rgba(0, 0, 0');
            expect(documentElement.styleProps.get('--hud-glow-color')).toContain('rgba(255, 196, 66');

            // Re-applying a theme WITHOUT the tokens must remove them — base-style
            // fallbacks (e.g. the play button's 1px primary border) take over again.
            mgr.applyTheme(BITMAGIC_THEME);
            expect(documentElement.styleProps.has('--hud-color-outline')).toBe(false);
            expect(documentElement.styleProps.has('--hud-border-width')).toBe(false);
            expect(documentElement.styleProps.has('--hud-text-outline-width')).toBe(false);
            expect(documentElement.styleProps.has('--hud-bevel-top')).toBe(false);
            expect(documentElement.styleProps.has('--hud-bevel-bottom')).toBe(false);
        });

        it('writes --hud-font-scale only when a theme rescales text', async () => {
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });

            // Built from an inline theme, not a preset: no shipped preset needs a
            // scale today (each has a face with a real weight range), but the
            // token stays part of the contract for themes whose face does not.
            const scaled = validateAndResolveTheme({
                ...BITMAGIC_THEME,
                font: { ...BITMAGIC_THEME.font, sizeScale: 1.15 },
            });
            if (!scaled.ok) throw new Error(scaled.errors.map(e => e.message).join('; '));
            mgr.applyTheme(scaled.theme);
            expect(documentElement.styleProps.get('--hud-font-scale')).toBe('1.15');

            // a theme that declares none must REMOVE it, not inherit the last one
            mgr.applyTheme(HUD_PRESETS.simulator);
            expect(documentElement.styleProps.has('--hud-font-scale')).toBe(false);
            expect(HUD_PRESETS.simulator.font.sizeScale).toBeUndefined();
        });

        it('toggles data-pixel-mode on the root from shape.imageRendering', async () => {
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });

            // No built-in preset is pixelated any more; an inline theme exercises
            // the same path a user-authored pixel theme would.
            const pixel = validateAndResolveTheme({
                ...BITMAGIC_THEME,
                shape: { ...BITMAGIC_THEME.shape, imageRendering: 'pixelated' },
            });
            if (!pixel.ok) throw new Error(pixel.errors.map(e => e.message).join('; '));
            mgr.applyTheme(pixel.theme);
            expect(root.datasetStore.pixelMode).toBe('true');

            mgr.applyTheme(BITMAGIC_THEME);
            expect(root.datasetStore.pixelMode).toBeUndefined();
        });

        it('per-element overrides apply scoped custom properties', async () => {
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });
            mgr.applyTheme(DARK_THEME);
            const node = makeStubElement();
            mgr.applyElementOverride(node as unknown as HTMLElement, 'healthBar');
            // the fixture's elements.healthBar overrides primary -> #C71010
            expect(node.styleProps.get('--hud-color-primary')).toBe('#C71010');
        });

        it('theme icons override the registry; color tokens are substituted', async () => {
            const { ThemeManager } = await import('engine/hud/ThemeManager.js');
            const { getIcon, _resetIconsForTests } = await import('engine/hud/icons.js');
            const { validateAndResolveTheme } = await import('engine/hud/validateTheme.js');

            _resetIconsForTests();
            // Default heart is the engine's built-in (uses currentColor).
            expect(getIcon('heart')).toContain('fill="currentColor"');

            const themed = validateAndResolveTheme({
                name: 'IconTest',
                font: { key: 'red-hat-display' },
                colors: {
                    primary: '#FF0080',
                    danger: '#FF0000',
                    background: '#000000',
                    surface: '#111111',
                    text: '#ffffff',
                },
                shape: {},
                icons: {
                    heart: '<svg><path fill="__primary__"/></svg>',
                },
            });
            expect(themed.ok).toBe(true);
            if (!themed.ok) return;

            const root = makeStubElement();
            const mgr = new ThemeManager({ root: root as unknown as HTMLElement, manageFontLink: true });
            mgr.applyTheme(themed.theme);

            // Heart was overridden AND __primary__ resolved to the theme's primary color.
            expect(getIcon('heart')).toBe('<svg><path fill="#FF0080"/></svg>');
            // Mouse + arrow weren't overridden — defaults stayed in place.
            expect(getIcon('mouse')).toContain('viewBox');
            expect(getIcon('arrow')).toContain('M12 5v14');

            _resetIconsForTests();
        });
    });
});

// --- DOM stub helpers ------------------------------------------------------

interface StubElement {
    tagName: string;
    children: StubElement[];
    styleProps: Map<string, string>;
    datasetStore: Record<string, string>;
    style: {
        setProperty: (k: string, v: string) => void;
        removeProperty: (k: string) => void;
    };
    dataset: Record<string, string>;
    appendChild: (child: StubElement) => StubElement;
    remove: () => void;
    id: string;
    href: string;
    rel: string;
    textContent: string;
}

function makeStubElement(tag = 'div'): StubElement {
    const styleProps = new Map<string, string>();
    const datasetStore: Record<string, string> = {};
    const el: StubElement = {
        tagName: tag.toUpperCase(),
        children: [],
        styleProps,
        datasetStore,
        style: {
            setProperty: (k: string, v: string) => {
                styleProps.set(k, v);
            },
            removeProperty: (k: string) => {
                styleProps.delete(k);
            },
        },
        dataset: new Proxy(datasetStore, {
            set(t, k, v) {
                if (typeof k === 'string' && typeof v === 'string') t[k] = v;
                return true;
            },
            deleteProperty(t, k) {
                if (typeof k === 'string') delete t[k];
                return true;
            },
        }),
        appendChild: (child: StubElement) => {
            el.children.push(child);
            return child;
        },
        remove: () => {
            /* no-op for stub */
        },
        id: '',
        href: '',
        rel: '',
        textContent: '',
    };
    return el;
}
