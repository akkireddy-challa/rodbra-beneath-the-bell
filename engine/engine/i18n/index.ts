import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from 'engine/i18n/locales/en.js';
import es from 'engine/i18n/locales/es.js';
import ptBR from 'engine/i18n/locales/pt-BR.js';
import fi from 'engine/i18n/locales/fi.js';

export type SupportedLanguage = 'en' | 'es' | 'pt-BR' | 'fi';

const LOCALIZATION_SETTINGS_KEY = 'aitopia5_localization_settings';

// Global state key to ensure all module instances share initialization state
// This fixes race conditions when bundlers create multiple module instances
const GLOBAL_I18N_KEY = '__aitopia5_i18n_state__';

interface GlobalI18nState {
    initialized: boolean;
    initPromise: Promise<void> | null;
}

// Get or create global state (survives across module instances)
function getGlobalState(): GlobalI18nState {
    const win = window as unknown as { [GLOBAL_I18N_KEY]?: GlobalI18nState };
    if (!win[GLOBAL_I18N_KEY]) {
        win[GLOBAL_I18N_KEY] = {
            initialized: false,
            initPromise: null
        };
    }
    return win[GLOBAL_I18N_KEY];
}

export interface LocalizationSettings {
    language: SupportedLanguage;
}

const defaultSettings: LocalizationSettings = {
    language: 'en',
};

function loadSettings(): LocalizationSettings {
    try {
        const saved = localStorage.getItem(LOCALIZATION_SETTINGS_KEY);
        if (saved) {
            return { ...defaultSettings, ...JSON.parse(saved) };
        }
    } catch (e) {
        console.warn('[i18n] Failed to load localization settings:', e);
    }
    return defaultSettings;
}

function saveSettings(settings: LocalizationSettings): void {
    try {
        localStorage.setItem(LOCALIZATION_SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
        console.warn('[i18n] Failed to save localization settings:', e);
    }
}

const resources = {
    en: { translation: en },
    es: { translation: es },
    'pt-BR': { translation: ptBR },
    fi: { translation: fi }
};

let currentSettings = loadSettings();

export async function initI18n(): Promise<void> {
    const globalState = getGlobalState();

    // If already initialized, return immediately
    if (globalState.initialized) return;

    // If initialization is in progress, wait for it
    if (globalState.initPromise) {
        await globalState.initPromise;
        return;
    }

    // Start initialization and store the promise globally
    globalState.initPromise = (async () => {
        try {
            await i18next
                .use(LanguageDetector)
                .init({
                    resources,
                    fallbackLng: 'en',
                    lng: currentSettings.language,
                    interpolation: {
                        escapeValue: false
                    },
                    detection: {
                        order: ['localStorage', 'navigator'],
                        lookupLocalStorage: 'aitopia5_language',
                        caches: ['localStorage']
                    }
                });

            globalState.initialized = true;
            console.log('[i18n] Initialized with language:', i18next.language);
        } catch (error) {
            console.error('[i18n] Failed to initialize:', error);
            // Mark as initialized anyway to prevent repeated attempts
            // t() will fall back to returning keys, which is better than crashing
            globalState.initialized = true;
        }
    })();

    await globalState.initPromise;
}

/**
 * Check if i18n is initialized (useful for conditional initialization)
 */
export function isI18nInitialized(): boolean {
    return getGlobalState().initialized;
}

/**
 * Get the initialization promise if you need to wait for i18n
 */
export function getI18nInitPromise(): Promise<void> | null {
    return getGlobalState().initPromise;
}

export function t(key: string, options?: Record<string, unknown>): string {
    const globalState = getGlobalState();
    if (!globalState.initialized) {
        console.warn('[i18n] Translation requested before initialization:', key);
        return key;
    }
    return i18next.t(key, options);
}

export function getCurrentLanguage(): SupportedLanguage {
    return (i18next.language || 'en') as SupportedLanguage;
}

export async function setLanguage(language: SupportedLanguage): Promise<void> {
    await i18next.changeLanguage(language);
    currentSettings.language = language;
    saveSettings(currentSettings);
    console.log('[i18n] Language changed to:', language);
}

export function getLocalizationSettings(): LocalizationSettings {
    return { ...currentSettings };
}

export function getSupportedLanguages(): Array<{ code: SupportedLanguage; name: string }> {
    return [
        { code: 'en', name: 'English' },
        { code: 'es', name: 'Español' },
        { code: 'pt-BR', name: 'Português (Brasil)' },
        { code: 'fi', name: 'Suomi' }
    ];
}

export { i18next };
