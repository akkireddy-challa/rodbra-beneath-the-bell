// Dynamic import map that rewrites module URLs with cache busting
// This intercepts module resolution without changing import statements

interface ImportMapEntry {
    [key: string]: string;
}

interface ImportMap {
    imports?: ImportMapEntry;
    scopes?: { [scope: string]: ImportMapEntry };
}

/**
 * Create and inject a dynamic import map that adds cache busting to genre files
 */
export function enableDynamicImportMap(): void {
    // Only enable in development
    const isDevelopment = window.location.hostname === 'localhost' ||
                         window.location.hostname === '127.0.0.1' ||
                         window.location.port === '8080';

    if (!isDevelopment) {
        console.log('[DynamicImportMap] Skipping import map in production');
        return;
    }

    // Check if import maps are supported
    if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('importmap')) {
        console.warn('[DynamicImportMap] Import maps not supported, falling back to other methods');
        return;
    }

    try {
        const cacheBuster = Date.now();

        // Create import map that redirects genre files
        const importMap: ImportMap = {
            imports: {
                // Add cache busting to commonly imported genre files
                './WorldGenerator.js': `./WorldGenerator.js?v=${cacheBuster}`
            }
        };

        // Create and inject the import map script
        const script = document.createElement('script');
        script.type = 'importmap';
        script.textContent = JSON.stringify(importMap, null, 2);

        // Insert before any module scripts
        const firstScript = document.querySelector('script');
        if (firstScript) {
            document.head.insertBefore(script, firstScript);
        } else {
            document.head.appendChild(script);
        }

        console.log('[DynamicImportMap] Import map enabled with cache busting');

    } catch (error) {
        console.warn('[DynamicImportMap] Failed to enable import map:', error);
    }
}

export default enableDynamicImportMap;