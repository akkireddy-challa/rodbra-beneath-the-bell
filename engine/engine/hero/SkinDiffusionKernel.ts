/**
 * Copyright (C) 2012 Jorge Jimenez (jorge@iryoku.com)
 * Copyright (C) 2012 Diego Gutierrez (diegog@unizar.es)
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 
 *    1. Redistributions of source code must retain the above copyright notice,
 *       this list of conditions and the following disclaimer.
 *
 *    2. Redistributions in binary form must reproduce the following disclaimer
 *       in the documentation and/or other materials provided with the 
 *       distribution:
 *
 *       "Uses Separable SSS. Copyright (C) 2012 by Jorge Jimenez and Diego
 *        Gutierrez."
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS ``AS 
 * IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, 
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR 
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL COPYRIGHT HOLDERS OR CONTRIBUTORS 
 * BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR 
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF 
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS 
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN 
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) 
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE 
 * POSSIBILITY OF SUCH DAMAGE.
 *
 * The views and conclusions contained in the software and documentation are 
 * those of the authors and should not be interpreted as representing official
 * policies, either expressed or implied, of the copyright holders.
 */


/** Adapted from iryoku/separable-sss Demo/Code/SeparableSSS.cpp (2012 demo).
 * Not the later 2015 importance-sampled implementation. Offsets span [-3,3].
 * Caller maps 3 to its explicit world-space support radius.
 */
export interface SkinKernelTap { offset: number; weight: [number, number, number] }
export function createSkinDiffusionKernel(
    falloff: readonly number[] = [1, 0.55, 0.3],
    strength: readonly number[] = [0.48, 0.41, 0.28],
    count = 25,
): SkinKernelTap[] {
    if (count < 3 || count % 2 !== 1 || falloff.length !== 3 || strength.length !== 3
        || !falloff.every(v => Number.isFinite(v) && v > 0)
        || !strength.every(v => Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error('Invalid skin diffusion profile');
    const range = count > 20 ? 3 : 2;
    const taps: SkinKernelTap[] = Array.from({ length: count }, (_, i) => {
        const o = -range + i * 2 * range / (count - 1);
        return { offset: Math.sign(o) * o * o / range, weight: [0, 0, 0] };
    });
    const gaussianWeights = [0.100, 0.118, 0.113, 0.358, 0.078];
    const variances = [0.0484, 0.187, 0.567, 1.99, 7.41];
    for (let i = 0; i < count; i++) {
        const tap = taps[i]!;
        const area = ((i > 0 ? tap.offset - taps[i - 1]!.offset : 0)
            + (i < count - 1 ? taps[i + 1]!.offset - tap.offset : 0)) / 2;
        for (let c = 0; c < 3; c++) {
            const r = tap.offset / (0.001 + falloff[c]!);
            tap.weight[c] = area * variances.reduce((sum, v, j) => sum
                + gaussianWeights[j]! * Math.exp(-r * r / (2 * v)) / (2 * Math.PI * v), 0);
        }
    }
    const center = taps.splice(Math.floor(count / 2), 1)[0]!;
    taps.unshift(center);
    for (let c = 0; c < 3; c++) {
        const sum = taps.reduce((s, t) => s + t.weight[c]!, 0);
        for (const tap of taps) tap.weight[c] = tap.weight[c]! / sum * strength[c]!;
        center.weight[c] = center.weight[c]! + 1 - strength[c]!;
    }
    return taps;
}
