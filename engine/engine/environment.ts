/**
 * Environment detection for the game engine.
 * Determines whether code is running in production, development, or local based on hostname.
 *
 * - bitmagic.ai → production
 * - bitmagic.cloud → development (GKE dev cluster)
 * - Otherwise (localhost, 127.0.0.1, etc.) → local
 */

export type Environment = 'production' | 'development' | 'local';

function detectEnvironment(): Environment {
    if (typeof window === 'undefined') {
        return 'local';
    }

    const hostname = window.location.hostname;

    if (hostname === 'bitmagic.ai' || hostname.endsWith('.bitmagic.ai')) {
        return 'production';
    }

    if (hostname === 'bitmagic.cloud' || hostname.endsWith('.bitmagic.cloud')) {
        return 'development';
    }

    return 'local';
}

/** Cached environment value — hostname doesn't change at runtime */
const ENV = detectEnvironment();

export function getEnvironment(): Environment {
    return ENV;
}

export function isProduction(): boolean {
    return ENV === 'production';
}

export function isDevelopment(): boolean {
    return ENV === 'development';
}

export function isLocal(): boolean {
    return ENV === 'local';
}
