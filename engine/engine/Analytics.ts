// Analytics system for game events
// Sends events to GTM in standalone mode, logs to console otherwise
//
// NOTE: When adding, removing, or changing events below, also update
// docs/analytics.md (the "Game client-side, standalone only" events table).

import { isStandaloneMode } from 'engine/CreatorMode.js';

export interface AnalyticsEvent {
    eventName: string;
    parameters: Record<string, string | number | boolean | undefined>;
}

export class Analytics {
    private isStandalone: boolean;

    constructor() {
        this.isStandalone = isStandaloneMode;
        console.log(`📊 Analytics initialized (standalone: ${this.isStandalone})`);
    }

    /**
     * Track an analytics event
     * In standalone mode: sends to GTM via dataLayer
     * In non-standalone mode: logs to console
     */
    trackEvent(eventName: string, parameters: Record<string, string | number | boolean | undefined> = {}): void {
        if (this.isStandalone) {
            this.sendToGTM(eventName, parameters);
        } else {
            this.logToConsole(eventName, parameters);
        }
    }

    private sendToGTM(eventName: string, parameters: Record<string, string | number | boolean | undefined>): void {
        // Check if GTM dataLayer exists
        if (typeof window !== 'undefined' && (window as any).dataLayer) {
            const eventData = {
                event: eventName,
                ...parameters
            };
            (window as any).dataLayer.push(eventData);
            console.log(`📊 Analytics Event Sent to GTM:`, eventData);
        } else {
            console.warn('📊 GTM dataLayer not found, event not sent:', eventName, parameters);
        }
    }

    private logToConsole(eventName: string, parameters: Record<string, string | number | boolean | undefined>): void {
        console.log(`📊 Analytics Event (Console Mode):`, {
            event: eventName,
            ...parameters
        });
    }

    /**
     * Track play button click event
     */
    trackPlayButtonClick(gameGenre?: string, gameId?: string, gameTitle?: string): void {
        this.trackEvent('creator_play_game_click', {
            game_genre: gameGenre,
            game_id: gameId,
            game_title: gameTitle
        });
    }

    /**
     * Track creation prompt submitted event
     */
    trackCreationPromptSubmitted(gameId?: string): void {
        this.trackEvent('creator_creation_prompt_submitted', {
            prompt_type: 'trending_game',
            game_id: gameId
        });
    }
}

// Singleton instance
let analyticsInstance: Analytics | null = null;

export function getAnalytics(): Analytics {
    if (!analyticsInstance) {
        analyticsInstance = new Analytics();
    }
    return analyticsInstance;
}
