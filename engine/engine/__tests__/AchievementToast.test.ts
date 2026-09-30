/**
 * AchievementToast markup. The toast is engine-owned because the first version
 * routed through the OPTIONAL `genreModule.hud`, so unlocks were silently
 * invisible in genres without a HUD — players earned achievements and saw
 * nothing.
 */
import { buildToastHtml, escapeHtml } from 'engine/progress/AchievementToast.js';

describe('buildToastHtml', () => {
    it('renders the art, name and XP', () => {
        const html = buildToastHtml({ name: 'Cleared a Block', imageUrl: 'https://cdn/x.webp', xp: 75 });
        expect(html).toContain('https://cdn/x.webp');
        expect(html).toContain('Cleared a Block');
        expect(html).toContain('+75 XP');
        expect(html).toContain('Achievement unlocked');
    });

    it('falls back to a placeholder mark when there is no art', () => {
        const html = buildToastHtml({ name: 'No Art', imageUrl: null, xp: 50 });
        expect(html).toContain('bm-achievement-toast__art--empty');
        expect(html).not.toContain('<img');
    });

    it('omits the XP line when the achievement is worth nothing', () => {
        expect(buildToastHtml({ name: 'Zero', xp: 0 })).not.toContain('XP');
        expect(buildToastHtml({ name: 'Absent' })).not.toContain('XP');
    });

    it('floors a fractional xp rather than printing a decimal', () => {
        expect(buildToastHtml({ name: 'Frac', xp: 12.7 })).toContain('+12 XP');
    });

    it('escapes creator-authored names — they reach innerHTML', () => {
        const html = buildToastHtml({ name: '<img src=x onerror=alert(1)>', xp: 10 });
        expect(html).not.toContain('<img src=x');
        expect(html).toContain('&lt;img src=x');
    });

    it('escapes a hostile image URL', () => {
        const html = buildToastHtml({ name: 'X', imageUrl: 'https://cdn/x.webp" onerror="alert(1)', xp: 5 });
        expect(html).not.toContain('onerror="alert(1)"');
        expect(html).toContain('&quot;');
    });
});

describe('escapeHtml', () => {
    it('escapes the five markup-significant characters', () => {
        expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
    });

    it('leaves ordinary text alone', () => {
        expect(escapeHtml('Cleared a Block')).toBe('Cleared a Block');
    });
});
