/**
 * Utility for getting the AI agent URL.
 * Prefers window.AI_AGENT_URL set by the parent frame (creator),
 * falls back to config.ts URL for standalone/dev usage.
 */

import { AI_AGENT_URL } from 'engine/config.js';

export function getAgentUrl(): string {
    const url = (window as unknown as { AI_AGENT_URL?: string }).AI_AGENT_URL;
    return url || AI_AGENT_URL;
}
