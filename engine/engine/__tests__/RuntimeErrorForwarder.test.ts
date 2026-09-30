/**
 * Runtime errors forwarded to the Creator (and on to the AI agent). Only errors
 * whose count grew since the last send go out, merged by message, so a
 * per-frame throw becomes one entry with a rising count instead of a flood.
 */
import type { CapturedMessage } from 'engine/ConsoleCapture.js';
import { collectNewErrors, shortenSourceUrls, truncateStack } from 'engine/RuntimeErrorForwarder.js';

function entry(message: string, count: number, type: 'warn' | 'error' = 'error', stack?: string): CapturedMessage {
    return { type, message, count, timestamp: 1000, stack };
}

describe('collectNewErrors', () => {
    it('ignores warnings', () => {
        expect(collectNewErrors([entry('slow asset', 3, 'warn')], new Map())).toEqual([]);
    });

    it('merges non-consecutive entries of the same message', () => {
        const errors = collectNewErrors([entry('boom', 2), entry('other', 1), entry('boom', 3)], new Map());
        expect(errors.map(e => [e.message, e.count])).toEqual([['boom', 5], ['other', 1]]);
    });

    it('sends only errors whose count changed since the last send', () => {
        const sent = new Map<string, number>();
        collectNewErrors([entry('boom', 1), entry('other', 1)], sent);
        const second = collectNewErrors([entry('boom', 4), entry('other', 1)], sent);
        expect(second.map(e => [e.message, e.count])).toEqual([['boom', 4]]);
        expect(collectNewErrors([entry('boom', 4), entry('other', 1)], sent)).toEqual([]);
    });
});

describe('truncateStack', () => {
    it('keeps only the first six frames', () => {
        const stack = ['TypeError: x', ...Array.from({ length: 10 }, (_, i) => `    at f${i} (work/A.js:${i}:1)`)].join('\n');
        const lines = truncateStack(stack)!.split('\n');
        expect(lines).toHaveLength(6);
        expect(lines[0]).toBe('at f0 (work/A.js:0:1)');
    });

    it('returns undefined without a stack', () => {
        expect(truncateStack(undefined)).toBeUndefined();
    });
});

describe('shortenSourceUrls', () => {
    it('reduces a script URL to its source path with line and column', () => {
        expect(shortenSourceUrls(
            "Uncaught TypeError: Cannot read properties of undefined (reading 'position') at http://localhost:3001/dist/work/Game.js?v=1790260069794:184:61"
        )).toBe("Uncaught TypeError: Cannot read properties of undefined (reading 'position') at work/Game.js:184:61");
    });

    it('handles stack frames in parentheses and URLs without a query', () => {
        expect(shortenSourceUrls('at GameEngine.animate (https://cdn.example.com/engine/GameEngine.js:10:5)'))
            .toBe('at GameEngine.animate (engine/GameEngine.js:10:5)');
    });

    it('gives the same error the same text across builds', () => {
        const before = collectNewErrors([{ type: 'error', message: 'boom at http://localhost:3001/dist/work/A.js?v=1:2:3', count: 1, timestamp: 0 }], new Map());
        const after = collectNewErrors([{ type: 'error', message: 'boom at http://localhost:3001/dist/work/A.js?v=2:2:3', count: 1, timestamp: 0 }], new Map());
        expect(before[0].message).toBe(after[0].message);
    });

    it('leaves text without URLs alone', () => {
        expect(shortenSourceUrls('plain message')).toBe('plain message');
    });
});
