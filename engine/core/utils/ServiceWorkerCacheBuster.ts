// Service Worker registration for automatic cache busting
// This enables transparent cache busting without code changes

/**
 * Register the cache buster service worker
 * This should be called early in the application lifecycle
 */
export async function registerCacheBusterServiceWorker(): Promise<void> {
    if ('serviceWorker' in navigator) {
        try {
            // Only register in development
            const isDevelopment = window.location.hostname === 'localhost' ||
                                 window.location.hostname === '127.0.0.1' ||
                                 window.location.port === '8080' ||
                                 window.location.port === '3001';

            if (!isDevelopment) {
                console.log('[ServiceWorkerCacheBuster] Skipping service worker in production');
                return;
            }

            const registration = await navigator.serviceWorker.register('/sw-cache-buster.js', {
                scope: '/'
            });

            console.log('[ServiceWorkerCacheBuster] Service worker registered successfully');


            // Listen for service worker updates
            registration.addEventListener('updatefound', () => {
                console.log('[ServiceWorkerCacheBuster] Service worker update found');
            });

            // Handle service worker messages
            navigator.serviceWorker.addEventListener('message', (event) => {
                console.log('[ServiceWorkerCacheBuster] Message from SW:', event.data);
            });

        } catch (error) {
            console.warn('[ServiceWorkerCacheBuster] Failed to register service worker:', error);
        }
    } else {
        console.warn('[ServiceWorkerCacheBuster] Service workers not supported');
    }
}

/**
 * Unregister the cache buster service worker
 */
export async function unregisterCacheBusterServiceWorker(): Promise<void> {
    if ('serviceWorker' in navigator) {
        try {
            const registrations = await navigator.serviceWorker.getRegistrations();

            for (const registration of registrations) {
                if (registration.scope.includes('sw-cache-buster')) {
                    await registration.unregister();
                    console.log('[ServiceWorkerCacheBuster] Service worker unregistered');
                }
            }
        } catch (error) {
            console.warn('[ServiceWorkerCacheBuster] Failed to unregister service worker:', error);
        }
    }
}

export default registerCacheBusterServiceWorker;