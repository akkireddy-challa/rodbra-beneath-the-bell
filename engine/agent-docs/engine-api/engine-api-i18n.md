# engine-api-i18n

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/i18n/index.ts
type SupportedLanguage = 'en' | 'es' | 'pt-BR' | 'fi'
interface LocalizationSettings
LocalizationSettings.language: SupportedLanguage
function initI18n(): Promise<void>
function isI18nInitialized(): boolean
function getI18nInitPromise(): Promise<void> | null
function t(key: string, options?: Record<string, unknown>): string
function getCurrentLanguage(): SupportedLanguage
function setLanguage(language: SupportedLanguage): Promise<void>
function getLocalizationSettings(): LocalizationSettings
function getSupportedLanguages(): Array<{ code: SupportedLanguage; name: string }>
