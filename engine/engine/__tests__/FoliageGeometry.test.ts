import * as THREE from 'three';
import { SeededRandom } from 'engine/SeededRandom.js';
import { createMeadowTuft, createBlockBlade, translateFoliage, foliageSeed } from 'engine/foliage/FoliageGeometry.js';
import { createGroundCoverTuft, createGroundCoverFlower } from 'engine/foliage/GroundCoverGeometry.js';

describe('rooted foliage geometry', () => {
    it.each([19, 73, 907])('plants every low-poly blade on sloping terrain (seed %i)', seed => {
        const heightAt = (x: number, z: number): number => x * 0.2 + z * 0.1;
        const geometry = createMeadowTuft(new SeededRandom(seed), -4, 3, heightAt(-4, 3), heightAt);
        translateFoliage(geometry, -4, heightAt(-4, 3), 3);
        const roots = geometry.getAttribute('foliageRoot'), positions = geometry.getAttribute('position');
        const flex = geometry.getAttribute('foliageFlex'), normals = geometry.getAttribute('normal');
        let rootedVertices = 0;
        for (let i = 0; i < roots.count; i++) {
            expect(roots.getY(i)).toBeCloseTo(heightAt(roots.getX(i), roots.getZ(i)), 5);
            expect(positions.getY(i)).toBeGreaterThanOrEqual(roots.getY(i) - 1e-6);
            if (flex.getX(i) === 0) {
                expect(positions.getY(i)).toBeCloseTo(roots.getY(i), 6); rootedVertices++;
            }
            expect(Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i))).toBeCloseTo(1, 5);
        }
        expect(rootedVertices).toBeGreaterThanOrEqual(21);
        expect(geometry.index!.count / 3).toBeLessThanOrEqual(180);
        geometry.dispose();
    });

    it('uses repeatable unsigned region seeds even at negative world coordinates', () => {
        const seed = foliageSeed(19, '-128,-256');
        expect(seed).toBeGreaterThanOrEqual(0);
        const make = (): THREE.BufferGeometry => createMeadowTuft(new SeededRandom(seed), 0, 0, 0, () => 0);
        const a = make(), b = make();
        expect(a.getAttribute('position').array).toEqual(b.getAttribute('position').array);
        expect(seed).not.toBe(foliageSeed(19, '-256,-128'));
        a.dispose(); b.dispose();
    });

    it('retains square block blade roots and gives them no wind weight', () => {
        const geometry = createBlockBlade(0.05), p = geometry.getAttribute('position'), flex = geometry.getAttribute('foliageFlex');
        let roots = 0;
        for (let i = 0; i < p.count; i++) if (p.getY(i) === 0) {
            expect(Math.abs(p.getX(i))).toBeCloseTo(0.025);
            expect(Math.abs(p.getZ(i))).toBeCloseTo(0.025);
            expect(flex.getX(i)).toBe(0); roots++;
        }
        expect(roots).toBeGreaterThan(0);
        geometry.dispose();
    });

    it('keeps forged ground cover within its dense-field geometry budget', () => {
        const tuft = createGroundCoverTuft(), flower = createGroundCoverFlower();
        expect(tuft.index!.count / 3).toBeLessThanOrEqual(9);
        expect(flower.index!.count / 3).toBeLessThanOrEqual(19);
        for (const geometry of [tuft, flower]) {
            const p = geometry.getAttribute('position'), flex = geometry.getAttribute('foliageFlex');
            for (let i = 0; i < p.count; i++) if (p.getY(i) === 0) expect(flex.getX(i)).toBe(0);
            geometry.dispose();
        }
    });
});
