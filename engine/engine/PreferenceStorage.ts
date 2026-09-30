const PREFIX = 'bitmagic-';

export function getPreference(key: string): string | undefined {
    try {
        return localStorage.getItem(PREFIX + key) || undefined;
    } catch {
        return undefined;
    }
}

export function setPreference(key: string, value: string): void {
    try {
        localStorage.setItem(PREFIX + key, value);
    } catch {
        // localStorage unavailable (e.g. private browsing)
    }
}
