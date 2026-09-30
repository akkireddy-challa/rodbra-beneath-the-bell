# engine-api-hud

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/hud/ThemeManager.ts
interface ThemeManagerOptions
ThemeManagerOptions.root: HTMLElement
ThemeManagerOptions.manageFontLink: boolean
const DEFAULT_THEME_MANAGER_OPTIONS: Omit<ThemeManagerOptions, 'root'>
function applyPartialThemeProperties(node: HTMLElement, partial: PartialTheme, base: ThemeColors): void
interface ApplyThemeGlobalsOptions
ApplyThemeGlobalsOptions.manageFontLink: boolean
const DEFAULT_APPLY_THEME_GLOBALS_OPTIONS: ApplyThemeGlobalsOptions
function getLastAppliedTheme(): ThemeTokens | null
function applyThemeGlobals(theme: ThemeTokens, options: ApplyThemeGlobalsOptions = DEFAULT_APPLY_THEME_GLOBALS_OPTIONS): void
class ThemeManager
ThemeManager.constructor(options: ThemeManagerOptions)
ThemeManager.getTheme(): ThemeTokens | null
ThemeManager.applyTheme(theme: ThemeTokens): void
ThemeManager.applyElementOverride(node: HTMLElement, elementClass: HudElementClass): void
ThemeManager.destroy(): void

## engine/hud/ThemeTokens.ts
type FontKey = | 'red-hat-display' | 'bebas-neue' | 'press-start-2p' | 'creepster' | 'pacifico' | 'space-grotesk' | 'rubik-mono-one' | 'vt323' | 'orbitron' | 'shrikhand' | 'lilita-one' | 'baloo-2' | 'fredoka' | 'grenze-gotisch' | 'cinzel' | 'chakra-petch' | 'ibm-plex-sans' | 'archivo-narrow'
type DecorationKey = | 'drip-border' | 'pixel-corners' | 'scanline' | 'vine-corner' | 'glow-aura' | 'bracket-frame' | 'ribbon-edge' | 'circuit-trace' | 'candy-gloss' | 'ornate-corner' | 'royal-frame' | 'hazard-stripes' | 'pixel-frame' | 'grain-texture'
type GlowKey = 'aqua' | 'pink' | 'warm' | 'horror-red' | 'gold' | 'cyan' | 'none'
type LabelCase = 'upper' | 'normal'
type ImageRendering = 'auto' | 'pixelated'
interface ThemeFont
ThemeFont.key: FontKey
ThemeFont.case: LabelCase
ThemeFont.weightBody: 300 | 400 | 500 | 700
ThemeFont.weightHeading: 400 | 500 | 700 | 900
ThemeFont.trackingLabel: number
ThemeFont.outlineWidth: number
ThemeFont.sizeScale?: number
interface ThemeColors
ThemeColors.primary: string
ThemeColors.danger: string
ThemeColors.warning: string
ThemeColors.success: string
ThemeColors.background: string
ThemeColors.surface: string
ThemeColors.text: string
ThemeColors.textMuted: string
ThemeColors.outline?: string
interface ThemeShape
ThemeShape.radiusPill: number
ThemeShape.radiusCard: number
ThemeShape.glow: GlowKey
ThemeShape.imageRendering: ImageRendering
ThemeShape.borderWidth: number
ThemeShape.bevel: number
ThemeShape.gloss: number
ThemeShape.glowColor?: string
interface BorderImageInline
BorderImageInline.svg: string
BorderImageInline.borderSlice: number
BorderImageInline.repeat: 'stretch' | 'repeat' | 'round' | 'space'
interface BackgroundInline
BackgroundInline.svg: string
BackgroundInline.size: 'cover' | 'contain' | 'auto' | (string & {})
BackgroundInline.position: | 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left' | 'top-left' | 'center'
BackgroundInline.repeat: 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y'
type BorderImageValue = DecorationKey | BorderImageInline
type BackgroundValue = DecorationKey | BackgroundInline
interface DecorationSlots
DecorationSlots.borderImage: BorderImageValue | null
DecorationSlots.backdrop: BackgroundValue | null
DecorationSlots.decorationBefore: BackgroundValue | null
DecorationSlots.decorationAfter: BackgroundValue | null
type HudElementClass = | 'progressBar' | 'healthBar' | 'counter' | 'iconText' | 'timer' | 'toast' | 'controls' | 'reticle' // The touch layer: joystick + on-screen action buttons. Every game must be // mobile-playable, and this is the surface that used to be unreachable by // theming. The base CSS already derives the stick from --hud-color-text and // the buttons from --hud-color-primary/danger/warning, so a per-element // colors override restyles the whole layer with no dedicated tokens. | 'mobileControls'
type Decorations = Partial<Record<HudElementClass, Partial<DecorationSlots>>>
interface ThemeIcons
ThemeIcons.heart?: string
ThemeIcons.mouse?: string
ThemeIcons.arrow?: string
interface PartialTheme
PartialTheme.font: Partial<ThemeFont> | null
PartialTheme.colors: Partial<ThemeColors> | null
PartialTheme.shape: Partial<ThemeShape> | null
PartialTheme.decorations: Partial<DecorationSlots> | null
interface ThemeTokens
ThemeTokens.name: string
ThemeTokens.font: ThemeFont
ThemeTokens.colors: ThemeColors
ThemeTokens.shape: ThemeShape
ThemeTokens.decorations: Decorations
ThemeTokens.elements: Partial<Record<HudElementClass, PartialTheme>>
ThemeTokens.icons: ThemeIcons
type ThemeInput = Omit<Partial<ThemeTokens>, 'font' | 'colors' | 'shape'> & { name: string; font: ThemeTokens['font'] | (Partial<ThemeFont> & { key: FontKey }); colors: ThemeTokens['colors']; shape: ThemeTokens['shape'] | Partial<ThemeShape>; }
const DEFAULT_THEME_FONT: ThemeFont
const DEFAULT_THEME_SHAPE: ThemeShape

## engine/hud/colorMath.ts
function relLuminance(hex: string): number
function contrastRatio(a: string, b: string): number
function mixHex(from: string, to: string, amount: number): string
function readableTextColor(hex: string): string
const ON_SURFACE_MIN_CONTRAST = 3
function inkOnSurface(surface: string, preferred: string): string
const ACCENT_INK_MIN_CONTRAST = 4.5
function accentInkOn(ground: string, accent: string): string | null
function mutedInkOnSurface(surface: string, preferred: string): string

## engine/hud/decorations.ts
type DecorationSlotKind = 'borderImage' | 'backdrop' | 'decorationBefore' | 'decorationAfter'
interface DecorationCatalogEntry
DecorationCatalogEntry.key: DecorationKey
DecorationCatalogEntry.svg: string
DecorationCatalogEntry.suitsSlots: ReadonlyArray<DecorationSlotKind>
DecorationCatalogEntry.borderImage?: { borderSlice: number; repeat: 'stretch' | 'repeat' | 'round' | 'space' }
DecorationCatalogEntry.background?: { /** * `cover` / `contain` / `auto`, or an explicit CSS tile size like * `'32px 32px'`. * * A REPEATING decoration must state an explicit size. Every SVG here * carries only a `viewBox`, which gives it no intrinsic size, so `auto` * does not mean "one tile at the viewBox dimensions" — the browser * scales a single copy to fill the element and the pattern renders as * one enormous motif. `circuit-trace` shipped that way and drew giant * crosshairs across the controls overlay. A unit test enforces this. */ size: 'cover' | 'contain' | 'auto' | (string & {}); position: | 'top' | 'top-right' | 'right' | 'bottom-right' | 'bottom' | 'bottom-left' | 'left' | 'top-left' | 'center'; repeat: 'no-repeat' | 'repeat' | 'repeat-x' | 'repeat-y'; }
DecorationCatalogEntry.evokes: string
const HUD_DECORATIONS: Readonly<Record<DecorationKey, DecorationCatalogEntry>>
function substituteThemeColors(svg: string, colors: ThemeColors): string
function svgToDataUri(svg: string): string

## engine/hud/fonts.ts
interface FontCatalogEntry
FontCatalogEntry.key: FontKey
FontCatalogEntry.family: string
FontCatalogEntry.weights: ReadonlyArray<number>
FontCatalogEntry.suitsCase: ReadonlyArray<LabelCase>
FontCatalogEntry.evokes: string
const HUD_FONTS: Readonly<Record<FontKey, FontCatalogEntry>>
interface FontStackOptions
FontStackOptions.fallback: string
const DEFAULT_FONT_STACK_OPTIONS: FontStackOptions
function getFontCssStack(key: FontKey, opts: FontStackOptions = DEFAULT_FONT_STACK_OPTIONS): string
function buildGoogleFontsUrl(key: FontKey, weights: ReadonlyArray<number>): string

## engine/hud/hudBaseStyles.ts
const HUD_BASE_STYLES = ` /* === HUD root: 9 INDEPENDENT anchor stacks =============
const GLOBAL_STYLE_ID = 'hud-base-styles'
function injectHudBaseStyles(): void
function _resetHudBaseStylesForTests(): void

## engine/hud/icons.ts
type IconName = 'heart' | 'mouse' | 'arrow'
const DEFAULT_ICONS: Readonly<Record<IconName, string>>
function getIcon(name: IconName): string
const ICON_HEART = DEFAULT_ICON_HEART
const ICON_MOUSE = DEFAULT_ICON_MOUSE
const ICON_ARROW_UP = DEFAULT_ICON_ARROW_UP
function setIconsFromTheme(icons: ThemeIcons | undefined, colors: ThemeColors): void
function _resetIconsForTests(): void
type ArrowDirection = 'up' | 'down' | 'left' | 'right'
function iconHtml(svg: string, extraClass = ''): string
function namedIconHtml(name: IconName, extraClass = ''): string
function arrowIconHtml(direction: ArrowDirection): string
function createIcon(svg: string, extraClass = ''): HTMLSpanElement
function createNamedIcon(name: IconName, extraClass = ''): HTMLSpanElement

## engine/hud/presets.ts
type PresetName = | 'rift-raider' | 'village-keep' | 'nexus' | 'simulator' | 'racing'
const PRESET_EVOKES: Readonly<Record<PresetName, string>>
const BITMAGIC_THEME: ThemeTokens
const DEFAULT_HUD_THEME: ThemeTokens
const RIFT_RAIDER_THEME: ThemeTokens
const VILLAGE_KEEP_THEME: ThemeTokens
const NEXUS_THEME: ThemeTokens
const SIMULATOR_THEME: ThemeTokens
const RACING_THEME: ThemeTokens
const HUD_PRESETS: Readonly<Record<PresetName, ThemeTokens>>

## engine/hud/resolveWorldTheme.ts
function resolveWorldTheme(value: string | Record<string, unknown> | undefined | null): ThemeTokens

## engine/hud/stylesheetCapture.ts
const ENGINE_HEAD_STYLE_IDS: ReadonlySet<string>
const MAX_RECORDED_STYLESHEET_CHARS = 32768
const MAX_RECORDED_STYLESHEET_TOTAL_CHARS = 131072
interface RecordedStylesheet
RecordedStylesheet.id: string
RecordedStylesheet.css: string
function _resetStylesheetCaptureForTests(): void
function collectGameHeadStylesheets(): RecordedStylesheet[]
function logGameStylesheets(): void

## engine/hud/themes/bitmagic.ts
const BITMAGIC_THEME_DATA = { name: 'Bitmagic', font: { key: 'red-hat-display', case: 'u

## engine/hud/themes/nexus.ts
const NEXUS_THEME_DATA = { name: 'Nexus', // One-line mood label, read by the agent c

## engine/hud/themes/racing.ts
const RACING_THEME_DATA = { name: 'Racing', // One-line mood label, read by the agent

## engine/hud/themes/rift-raider.ts
const RIFT_RAIDER_THEME_DATA = { name: 'Rift Raider', // One-line mood label, read by the a

## engine/hud/themes/simulator.ts
const SIMULATOR_THEME_DATA = { name: 'Simulator', // One-line mood label, read by the age

## engine/hud/themes/village-keep.ts
const VILLAGE_KEEP_THEME_DATA = { name: 'Village Keep', // One-line mood label, read by the

## engine/hud/validateTheme.ts
interface ValidationIssue
ValidationIssue.path: string
ValidationIssue.message: string
ValidationIssue.suggestion?: string
type ValidationResult = | { ok: true; theme: ThemeTokens; warnings: ValidationIssue[] } | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] }
function suggestClosest(value: string, candidates: ReadonlyArray<string>): string | undefined
function validateAndResolveTheme(input: unknown): ValidationResult
