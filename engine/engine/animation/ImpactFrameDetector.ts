/**
 * Pure heuristic that estimates an action animation's contact ("impact") frame
 * from per-end-effector world-space speed series sampled across the clip.
 *
 * No Three.js here on purpose — sampling lives in MixamoAnimationPlayer; this
 * module is the unit-testable decision logic.
 */

export interface ImpactGateOptions {
    /** Minimum ratio of the striking limb's peak speed to its mean speed.
     *  Rejects low-contrast motion (idles, gentle gestures). */
    minPeakToMeanRatio: number;
    /** A clip qualifies as a strike only if its striking limb has exactly ONE
     *  prominent speed peak above this fraction of the global peak. Rejects
     *  oscillating locomotion (a run cycle has a peak per stride). */
    prominentPeakThreshold: number;
}

export const DEFAULT_IMPACT_GATE: ImpactGateOptions = {
    minPeakToMeanRatio: 2.5,
    prominentPeakThreshold: 0.5,
};

/** Minimum samples needed for a reliable prominent-peak count. With <3
 *  samples every non-zero endpoint qualifies as a local max. */
const MIN_SERIES_LENGTH = 3;

/** Count local maxima whose value exceeds `threshold`. Endpoints count when
 *  they exceed their single neighbour. */
function countProminentPeaks(series: number[], threshold: number): number {
    let count = 0;
    for (let i = 0; i < series.length; i++) {
        const v = series[i]!;
        if (v <= threshold) continue;
        const left = i > 0 ? series[i - 1]! : -Infinity;
        const right = i < series.length - 1 ? series[i + 1]! : -Infinity;
        if (v >= left && v >= right) count++;
    }
    return count;
}

/** A detected strike: the contact-frame fraction plus which end-effector struck. */
export interface ImpactStrike {
    /** Clip-local fraction where 0.0 = first sample, 1.0 = last sample. */
    fraction: number;
    /** The striking end-effector — the `speedSeries` key with the peak speed (e.g. 'rightFoot'). */
    part: string;
}

/**
 * @param speedSeries  end-effector name -> per-sample speed (length = samples-1)
 * @returns the strike (contact-frame fraction + striking end-effector key), or
 *          null when no clear single strike is present.
 */
export function pickImpactStrike(
    speedSeries: Map<string, number[]>,
    options: ImpactGateOptions = DEFAULT_IMPACT_GATE,
): ImpactStrike | null {
    let strikingLimbSeries: number[] | null = null;
    let strikingPart: string | null = null;
    let bestPeak = -Infinity;
    let bestPeakIndex = -1;

    // strikingLimbSeries/strikingPart/bestPeakIndex are updated together, so
    // bestPeakIndex is the index of bestPeak within strikingLimbSeries.
    for (const [part, series] of speedSeries.entries()) {
        for (let i = 0; i < series.length; i++) {
            if (series[i]! > bestPeak) {
                bestPeak = series[i]!;
                bestPeakIndex = i;
                strikingLimbSeries = series;
                strikingPart = part;
            }
        }
    }

    if (!strikingLimbSeries || strikingPart === null || strikingLimbSeries.length < MIN_SERIES_LENGTH || bestPeak <= 0) return null;

    const mean = strikingLimbSeries.reduce((a, b) => a + b, 0) / strikingLimbSeries.length;
    if (bestPeak / mean < options.minPeakToMeanRatio) return null;

    const peaks = countProminentPeaks(strikingLimbSeries, bestPeak * options.prominentPeakThreshold);
    if (peaks !== 1) return null;

    return { fraction: bestPeakIndex / (strikingLimbSeries.length - 1), part: strikingPart };
}

/**
 * @param speedSeries  end-effector name -> per-sample speed (length = samples-1)
 * @returns normalized clip-local fraction where 0.0 = first sample, 1.0 = last sample,
 *          or null when no clear single strike is present.
 */
export function pickImpactFraction(
    speedSeries: Map<string, number[]>,
    options: ImpactGateOptions = DEFAULT_IMPACT_GATE,
): number | null {
    return pickImpactStrike(speedSeries, options)?.fraction ?? null;
}
