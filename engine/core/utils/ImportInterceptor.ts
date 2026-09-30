// ES Module import interceptor for cache busting
// This creates a global utility that can be used by any file needing dynamic imports

/**
 * Global cache-busted import function
 * This should be used instead of direct import() calls in genre files
 *
 * Usage:
 *   Instead of: await import('./MyModule.js')
 *   Use: await __import('./MyModule.js')
 */
function createCacheBustedImport() {
    return async function __import(modulePath: string): Promise<any> {
        // Only enable cache busting in development
        const isDevelopment = typeof window !== 'undefined' && (
            window.location.hostname === 'localhost' ||
            window.location.hostname === '127.0.0.1' ||
            window.location.protocol === 'file:'
        );

        if (!isDevelopment) {
            return import(modulePath);
        }

        // Determine if this is a genre file that needs cache busting
        const isGenreFile = modulePath.includes('./') ||
                           modulePath.includes('../') ||
                           modulePath.includes('/genres/');

        if (isGenreFile && !modulePath.includes('?v=')) {
            const cacheBuster = Date.now();
            const separator = modulePath.includes('?') ? '&' : '?';
            const cacheBustedPath = `${modulePath}${separator}v=${cacheBuster}`;

            console.log(`[ImportInterceptor] Cache busting: ${modulePath} -> ${cacheBustedPath}`);
            return import(cacheBustedPath);
        }

        return import(modulePath);
    };
}

// Create the global import function
const __import = createCacheBustedImport();

// Make it available globally
if (typeof globalThis !== 'undefined') {
    (globalThis as any).__import = __import;
}
if (typeof window !== 'undefined') {
    (window as any).__import = __import;
}

export { __import };
export default __import;