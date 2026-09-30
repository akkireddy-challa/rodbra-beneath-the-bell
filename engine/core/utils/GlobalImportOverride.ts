// Global import function override for transparent cache busting
// This patches the browser's import function without requiring code changes

declare global {
    interface Window {
        __originalDynamicImport?: (specifier: string) => Promise<any>;
        __cacheBustingActive?: boolean;
    }
}

let isOverrideActive = false;

/**
 * Enable global import override for automatic cache busting
 * This works by intercepting calls to import() at the browser level
 */
export function enableGlobalImportOverride(): void {
    if (isOverrideActive) {
        console.log('[GlobalImportOverride] Already active');
        return;
    }

    // Only enable in development
    const isDevelopment = window.location.hostname === 'localhost' ||
                         window.location.hostname === '127.0.0.1' ||
                         window.location.port === '8080';

    if (!isDevelopment) {
        console.log('[GlobalImportOverride] Skipping in production');
        return;
    }

    try {
        // Store original import function if available
        if (!window.__originalDynamicImport) {
            // Try to capture the original import function
            window.__originalDynamicImport = (0, eval)('(function() { return import; })()');
        }

        // Override the global import function using a different approach
        const script = document.createElement('script');
        script.textContent = `
            (function() {
                const originalImport = window.__originalDynamicImport || ((s) => import(s));

                // Create a wrapper function
                const cacheBustedImport = function(specifier) {
                    // Check if this is a genre file that needs cache busting
                    const isLocalImport = specifier.startsWith('./') || specifier.startsWith('../');
                    const isGenreImport = specifier.includes('/genres/');
                    const needsCacheBusting = isLocalImport || isGenreImport;

                    if (needsCacheBusting && !specifier.includes('?v=')) {
                        const cacheBuster = Date.now();
                        const separator = specifier.includes('?') ? '&' : '?';
                        const cacheBustedSpecifier = specifier + separator + 'v=' + cacheBuster;

                        console.log('[GlobalImportOverride] Cache busting:', specifier, '->', cacheBustedSpecifier);
                        return originalImport(cacheBustedSpecifier);
                    }

                    return originalImport(specifier);
                };

                // Try to override import in various ways
                try {
                    // Method 1: Override window.import (if it exists)
                    if (typeof window.import === 'function') {
                        window.import = cacheBustedImport;
                    }

                    // Method 2: Override global import (more aggressive)
                    Object.defineProperty(window, 'import', {
                        value: cacheBustedImport,
                        writable: true,
                        configurable: true
                    });

                } catch (e) {
                    console.warn('[GlobalImportOverride] Could not override import function:', e);
                }

                window.__cacheBustingActive = true;
                console.log('[GlobalImportOverride] Global import override enabled');
            })();
        `;

        document.head.appendChild(script);
        isOverrideActive = true;

    } catch (error) {
        console.warn('[GlobalImportOverride] Failed to enable global import override:', error);
    }
}

/**
 * Disable global import override
 */
export function disableGlobalImportOverride(): void {
    if (!isOverrideActive) {
        return;
    }

    try {
        if (window.__originalDynamicImport) {
            (window as any).import = window.__originalDynamicImport;
        }

        window.__cacheBustingActive = false;
        isOverrideActive = false;

        console.log('[GlobalImportOverride] Global import override disabled');

    } catch (error) {
        console.warn('[GlobalImportOverride] Failed to disable global import override:', error);
    }
}

/**
 * Check if global import override is active
 */
export function isGlobalImportOverrideActive(): boolean {
    return isOverrideActive && window.__cacheBustingActive === true;
}

export default enableGlobalImportOverride;