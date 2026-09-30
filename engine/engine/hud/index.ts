// Public surface of the HUD theme system. Callers (GameHUD and templates that
// need to read theme state) should import from this barrel rather than reach
// into individual modules.

export {
    type ThemeTokens,
    type ThemeFont,
    type ThemeColors,
    type ThemeShape,
    type ThemeInput,
    type ThemeIcons,
    type PartialTheme,
    type Decorations,
    type DecorationSlots,
    type BorderImageValue,
    type BackgroundValue,
    type BorderImageInline,
    type BackgroundInline,
    type HudElementClass,
    type FontKey,
    type DecorationKey,
    type GlowKey,
    type LabelCase,
    type ImageRendering,
    DEFAULT_THEME_FONT,
    DEFAULT_THEME_SHAPE,
} from 'engine/hud/ThemeTokens.js';

export {
    HUD_FONTS,
    type FontCatalogEntry,
    getFontCssStack,
    buildGoogleFontsUrl,
} from 'engine/hud/fonts.js';

export {
    HUD_DECORATIONS,
    type DecorationCatalogEntry,
    type DecorationSlotKind,
    substituteThemeColors,
    svgToDataUri,
} from 'engine/hud/decorations.js';

export {
    validateAndResolveTheme,
    type ValidationIssue,
    type ValidationResult,
} from 'engine/hud/validateTheme.js';

export {
    ThemeManager,
    type ThemeManagerOptions,
    DEFAULT_THEME_MANAGER_OPTIONS,
    applyThemeGlobals,
    applyPartialThemeProperties,
    getLastAppliedTheme,
    type ApplyThemeGlobalsOptions,
    DEFAULT_APPLY_THEME_GLOBALS_OPTIONS,
} from 'engine/hud/ThemeManager.js';

export {
    HUD_BASE_STYLES,
    injectHudBaseStyles,
    _resetHudBaseStylesForTests,
} from 'engine/hud/hudBaseStyles.js';

export {
    ENGINE_HEAD_STYLE_IDS,
    MAX_RECORDED_STYLESHEET_CHARS,
    MAX_RECORDED_STYLESHEET_TOTAL_CHARS,
    type RecordedStylesheet,
    collectGameHeadStylesheets,
    logGameStylesheets,
    _resetStylesheetCaptureForTests,
} from 'engine/hud/stylesheetCapture.js';

export {
    BITMAGIC_THEME,
    DEFAULT_HUD_THEME,
    RIFT_RAIDER_THEME,
    VILLAGE_KEEP_THEME,
    NEXUS_THEME,
    SIMULATOR_THEME,
    RACING_THEME,
    HUD_PRESETS,
    PRESET_EVOKES,
    type PresetName,
} from 'engine/hud/presets.js';

export { resolveWorldTheme } from 'engine/hud/resolveWorldTheme.js';

export {
    ICON_HEART,
    ICON_MOUSE,
    ICON_ARROW_UP,
    DEFAULT_ICONS,
    type IconName,
    type ArrowDirection,
    iconHtml,
    arrowIconHtml,
    namedIconHtml,
    createIcon,
    createNamedIcon,
    getIcon,
    setIconsFromTheme,
    _resetIconsForTests,
} from 'engine/hud/icons.js';
