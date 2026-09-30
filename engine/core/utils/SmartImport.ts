// Smart import utility that automatically detects and cache-busts genre file imports
// This can be used as a drop-in replacement for import() in any file

/**
 * Smart import function with automatic cache busting for development
 * @param modulePath - The module path to import
 * @returns Promise resolving to the imported module
 */
export async function smartImport(modulePath: string): Promise<any> {
    // Only enable cache busting in development environments
    const isDevelopment = typeof window !== 'undefined' && (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.port === '8080' ||
        window.location.protocol === 'file:'
    );

    if (!isDevelopment) {
        return import(modulePath);
    }

    // Check if this looks like a genre-related file
    const isLocalImport = modulePath.startsWith('./') || modulePath.startsWith('../');
    const isGenreImport = modulePath.includes('/genres/');
    const needsCacheBusting = isLocalImport || isGenreImport;

    if (needsCacheBusting && !modulePath.includes('?v=')) {
        const cacheBuster = Date.now();
        const separator = modulePath.includes('?') ? '&' : '?';
        const cacheBustedPath = `${modulePath}${separator}v=${cacheBuster}`;

        console.log(`[SmartImport] Cache busting: ${modulePath}`);
        return import(cacheBustedPath);
    }

    return import(modulePath);
}

// Export as default and named export for convenience
export default smartImport;