/**
 * The merge must be LOSSLESS — that is the whole justification for collapsing a
 * block character into one instanced draw rather than accepting a coarser look
 * at distance. These tests pin that a vertex, once posed by its part matrix,
 * lands exactly where the un-merged part hierarchy would have put it.
 *
 * The unit of articulation is the body-part GROUP, not a skeleton bone — see
 * PartBinding for why sampling bones does not reproduce this rig.
 */
import * as THREE from 'three';
import { mergeBlockCharacter } from 'engine/npc/crowd/CrowdMeshBake.js';
import type { PartBinding } from 'engine/npc/crowd/CrowdMeshBake.js';

/** A part group holding one unit box, placed where the rig put the part. */
function makePart(name: string, partOffset: THREE.Vector3, boxOffset: THREE.Vector3): PartBinding {
    const group = new THREE.Group();
    group.name = name;
    group.position.copy(partOffset);
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshStandardMaterial({ color: 0x336699 }),
    );
    mesh.position.copy(boxOffset);
    group.add(mesh);
    return { group };
}

/** World position of a baked vertex once its part matrix is applied. */
function posedVertex(
    merged: ReturnType<typeof mergeBlockCharacter>,
    vertexIndex: number,
    partWorld: THREE.Matrix4[],
): THREE.Vector3 {
    const pos = merged.geometry.getAttribute('position');
    const bi = merged.geometry.getAttribute('boneIndex').getX(vertexIndex);
    return new THREE.Vector3(pos.getX(vertexIndex), pos.getY(vertexIndex), pos.getZ(vertexIndex))
        .applyMatrix4(partWorld[bi]!);
}

describe('mergeBlockCharacter', () => {
    test('collapses every part mesh into one geometry', () => {
        const parts = [
            makePart('torso', new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0)),
            makePart('head', new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0.2, 0)),
            makePart('armL', new THREE.Vector3(0.6, 1.5, 0), new THREE.Vector3(0, -0.3, 0)),
        ];
        const merged = mergeBlockCharacter(parts);
        expect(merged.sourceMeshCount).toBe(3);
        expect(merged.boneNames).toEqual(['torso', 'head', 'armL']);
        expect(merged.triangleCount).toBe(36); // 3 boxes x 12 triangles
    });

    test('a baked vertex posed by its bind matrix returns to its original world position', () => {
        // This is the losslessness claim: bake then pose is the identity when
        // the part has not moved since the bake.
        const parts = [makePart('head', new THREE.Vector3(0, 2, 0), new THREE.Vector3(0.25, 0.1, -0.4))];
        parts[0]!.group.updateWorldMatrix(true, true);
        const mesh = parts[0]!.group.children[0] as THREE.Mesh;
        const original = new THREE.Vector3(
            mesh.geometry.getAttribute('position').getX(0),
            mesh.geometry.getAttribute('position').getY(0),
            mesh.geometry.getAttribute('position').getZ(0),
        ).applyMatrix4(mesh.matrixWorld);

        const merged = mergeBlockCharacter(parts);
        const posed = posedVertex(merged, 0, merged.bindMatrices);
        expect(posed.x).toBeCloseTo(original.x, 5);
        expect(posed.y).toBeCloseTo(original.y, 5);
        expect(posed.z).toBeCloseTo(original.z, 5);
    });

    test('moving one part moves exactly the vertices bound to it', () => {
        const parts = [
            makePart('torso', new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0)),
            makePart('head', new THREE.Vector3(0, 2, 0), new THREE.Vector3(0, 0, 0)),
        ];
        const merged = mergeBlockCharacter(parts);
        // Raise only the head part by 1.
        const posed = merged.bindMatrices.map((m) => m.clone());
        posed[1]!.premultiply(new THREE.Matrix4().makeTranslation(0, 1, 0));

        const bi = merged.geometry.getAttribute('boneIndex');
        for (let i = 0; i < bi.count; i++) {
            const before = posedVertex(merged, i, merged.bindMatrices);
            const after = posedVertex(merged, i, posed);
            const dy = after.y - before.y;
            expect(dy).toBeCloseTo(bi.getX(i) === 1 ? 1 : 0, 5);
        }
    });

    test('one influence per vertex — no skin weights needed', () => {
        const merged = mergeBlockCharacter([makePart('torso', new THREE.Vector3(), new THREE.Vector3())]);
        expect(merged.geometry.getAttribute('boneIndex')).toBeDefined();
        expect(merged.geometry.getAttribute('skinWeight')).toBeUndefined();
        expect(merged.geometry.getAttribute('skinIndex')).toBeUndefined();
    });

    test('material colour is carried into vertex colours', () => {
        // A merged mesh has ONE material, so per-part palette must survive as
        // vertex colour or the whole character turns a single shade.
        const part = makePart('torso', new THREE.Vector3(), new THREE.Vector3());
        ((part.group.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial)
            .color.setRGB(0.25, 0.5, 0.75);
        const merged = mergeBlockCharacter([part]);
        const col = merged.geometry.getAttribute('color');
        expect(col.getX(0)).toBeCloseTo(0.25, 3);
        expect(col.getY(0)).toBeCloseTo(0.5, 3);
        expect(col.getZ(0)).toBeCloseTo(0.75, 3);
    });

    test('each part group gets its own index even when one bone drives both', () => {
        // Two parts can share a driving bone, but they are still posed
        // SEPARATELY by the rig (different joint pairs, different offsets), so
        // collapsing them onto one index would weld them together.
        const mk = (name: string, y: number): PartBinding => {
            const g = new THREE.Group();
            g.name = name;
            g.position.set(0, y, 0);
            g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
            return { group: g };
        };
        const merged = mergeBlockCharacter([mk('spineLower', 1), mk('spineUpper', 2)]);
        expect(merged.boneNames).toEqual(['spineLower', 'spineUpper']);
        expect(merged.sourceMeshCount).toBe(2);

        // And they move independently.
        const posed = merged.bindMatrices.map((m) => m.clone());
        posed[1]!.premultiply(new THREE.Matrix4().makeTranslation(0, 1, 0));
        const bi = merged.geometry.getAttribute('boneIndex');
        for (let i = 0; i < bi.count; i++) {
            const dy = posedVertex(merged, i, posed).y - posedVertex(merged, i, merged.bindMatrices).y;
            expect(dy).toBeCloseTo(bi.getX(i) === 1 ? 1 : 0, 5);
        }
    });

    test('an empty binding list yields an empty geometry rather than throwing', () => {
        const merged = mergeBlockCharacter([]);
        expect(merged.triangleCount).toBe(0);
        expect(merged.sourceMeshCount).toBe(0);
    });
});
