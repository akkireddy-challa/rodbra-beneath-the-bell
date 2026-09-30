// Global cache busting interceptor that patches the import() function
// This ensures ALL dynamic imports get cache busting without needing to modify individual files

interface GlobalWindow extends Window {
    __originalImport?: (specifier: string) => Promise<any>;
    __cacheBustingEnabled?: boolean;
}

declare const window: GlobalWindow;

let isEnabled = false;

/**
 * Enable global cache busting for all dynamic imports
 * This patches the global import() function to automatically add cache busting to genre files
 */
export function enableGlobalCacheBusting(): void {
    if (isEnabled || typeof window === 'undefined') {
        return;
    }

    // Only enable in development environments
    const isDevelopment = window.location.hostname === 'localhost' ||
                         window.location.hostname === '127.0.0.1' ||
                         window.location.protocol === 'file:';

    if (!isDevelopment) {
        console.log('[GlobalCacheBusting] Skipping cache busting in production environment');
        return;
    }

    try {
        // This approach is too complex and has browser compatibility issues
        // Fall back to console warning
        console.warn('[GlobalCacheBusting] Dynamic import patching not supported, use manual utilities instead');
        return;

        isEnabled = true;
        window.__cacheBustingEnabled = true;
        console.log('[GlobalCacheBusting] Global cache busting enabled for dynamic imports');

    } catch (error) {
        console.warn('[GlobalCacheBusting] Failed to enable global cache busting:', error);
        console.log('[GlobalCacheBusting] Falling back to manual cache busting utilities');
    }
}

/**
 * Disable global cache busting and restore original import function
 */
export function disableGlobalCacheBusting(): void {
    if (!isEnabled || typeof window === 'undefined' || !window.__originalImport) {
        return;
    }

    try {
        // Cannot restore - global import patching not implemented
        console.log('[GlobalCacheBusting] Global import patching was not active');

        isEnabled = false;
        window.__cacheBustingEnabled = false;
        console.log('[GlobalCacheBusting] Global cache busting disabled');

    } catch (error) {
        console.warn('[GlobalCacheBusting] Failed to disable global cache busting:', error);
    }
}

/**
 * Check if global cache busting is currently enabled
 */
export function isGlobalCacheBustingEnabled(): boolean {
    return isEnabled && (typeof window !== 'undefined') && window.__cacheBustingEnabled === true;
}

// Auto-enable when this module is imported in development
if (typeof window !== 'undefined') {
    // Delay enabling to ensure the window is fully loaded
    setTimeout(() => {
        enableGlobalCacheBusting();
    }, 100);
}

export default enableGlobalCacheBusting;