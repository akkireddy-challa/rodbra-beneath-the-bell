import { triBoxOverlap } from 'engine/vxlscene/triBoxOverlap.js';

const C: [number, number, number] = [0.5, 0.5, 0.5];
const H: [number, number, number] = [0.5, 0.5, 0.5]; // unit box [0,1]^3

describe('triBoxOverlap', () => {
    it('tiny triangle fully inside', () => {
        expect(triBoxOverlap(C, H, [0.5, 0.5, 0.5], [0.6, 0.5, 0.5], [0.5, 0.6, 0.5])).toBe(true);
    });
    it('triangle far outside', () => {
        expect(triBoxOverlap(C, H, [5, 5, 5], [6, 5, 5], [5, 6, 5])).toBe(false);
    });
    it('triangle spanning across the box', () => {
        expect(triBoxOverlap(C, H, [-1, 0.5, 0.5], [2, 0.5, 0.5], [0.5, 2, 0.5])).toBe(true);
    });
    it('triangle in a parallel plane just outside', () => {
        expect(triBoxOverlap(C, H, [0, 0, 1.6], [1, 0, 1.6], [0, 1, 1.6])).toBe(false);
    });
    it('triangle clipping just one corner still overlaps', () => {
        // Triangle symmetric around (1,1,1): all vertices outside the box but
        // the interior of the triangle clips the +x+y+z corner.
        expect(triBoxOverlap(C, H, [1.4, 0.75, 0.75], [0.75, 1.4, 0.75], [0.75, 0.75, 1.4])).toBe(true);
    });
});
