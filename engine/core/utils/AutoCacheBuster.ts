// Auto-initializing cache buster that tries multiple approaches
// This combines all methods and picks the best one available

import { registerCacheBusterServiceWorker } from './ServiceWorkerCacheBuster.js';
import { enableDynamicImportMap } from './DynamicImportMap.js';
import { enableGlobalImportOverride } from './GlobalImportOverride.js';

/**
 * Initialize automatic cache busting using the best available method
 * This tries multiple approaches in order of preference
 */
export async function initializeAutoCacheBusting(): Promise<void> {
    // Packaged Poki builds are also tested on localhost; they must never install dev workers.
    if (document.querySelector('meta[name="bm:distribution"][content="poki"]')) return;
    // Only enable in development
    const isDevelopment = window.location.hostname === 'localhost' ||
                         window.location.hostname === '127.0.0.1' ||
                         window.location.port === '8080' ||
                         window.location.port === '3001';

    if (!isDevelopment) {
        console.log('[AutoCacheBuster] Skipping auto cache busting in production');
        return;
    }

    console.log('[AutoCacheBuster] Initializing automatic cache busting...');

    // Method 1: Try Service Worker (most robust, works for all requests)
    try {
        if ('serviceWorker' in navigator) {
            await registerCacheBusterServiceWorker();
            console.log('[AutoCacheBuster] Using Service Worker method');
            return;
        }
    } catch (error) {
        console.warn('[AutoCacheBuster] Service Worker method failed:', error);
    }

    // Method 2: Try Import Maps (clean, standards-based)
    try {
        if (HTMLScriptElement.supports && HTMLScriptElement.supports('importmap')) {
            enableDynamicImportMap();
            console.log('[AutoCacheBuster] Using Import Map method');
            return;
        }
    } catch (error) {
        console.warn('[AutoCacheBuster] Import Map method failed:', error);
    }

    // Method 3: Try Global Import Override (last resort)
    try {
        enableGlobalImportOverride();
        console.log('[AutoCacheBuster] Using Global Import Override method');
        return;
    } catch (error) {
        console.warn('[AutoCacheBuster] Global Import Override method failed:', error);
    }

    console.warn('[AutoCacheBuster] All automatic cache busting methods failed');
    console.log('[AutoCacheBuster] Falling back to manual cache busting utilities');
}

// Auto-initialize when this module is loaded
if (typeof window !== 'undefined') {
    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initializeAutoCacheBusting);
    } else {
        // DOM is already ready
        setTimeout(initializeAutoCacheBusting, 0);
    }
}

export default initializeAutoCacheBusting;
