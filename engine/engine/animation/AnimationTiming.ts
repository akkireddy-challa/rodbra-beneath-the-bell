/** Clip-local phase markers. Generated exports carry these on scene extras;
 * older assets keep their existing detected timing and hit-check defaults. */
export interface AnimationTiming {
    startTime: number;
    impactPhase: number | null;
    contactStart: number | null;
    contactEnd: number | null;
}

export function readAnimationTiming(value: unknown): AnimationTiming {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const phase = (key: string): number | null => {
        const n = record[key];
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
    };
    const start = record.startTime;
    const contactStart = phase('contactStart');
    const contactEnd = phase('contactEnd');
    const validWindow = contactStart !== null && contactEnd !== null && contactStart < contactEnd;
    return {
        startTime: typeof start === 'number' && Number.isFinite(start) && start >= 0 ? start : 0,
        impactPhase: phase('impactPhase'),
        contactStart: validWindow ? contactStart : null,
        contactEnd: validWindow ? contactEnd : null,
    };
}

export function contactCheckPhases(timing: AnimationTiming, fallback: readonly number[]): readonly number[] {
    if (timing.contactStart === null || timing.contactEnd === null) return fallback;
    const phases = [timing.contactStart, timing.contactEnd];
    for (let i = 1; i < 4; i++) phases.push(timing.contactStart + (timing.contactEnd - timing.contactStart) * i / 4);
    if (timing.impactPhase !== null) phases.push(timing.impactPhase);
    return [...new Set(phases)].sort((a, b) => a - b);
}
