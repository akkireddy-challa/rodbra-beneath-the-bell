import * as THREE from 'three';
import { HeroCharacter } from 'engine/hero/HeroCharacter.js';
import { HeroFaceController } from 'engine/hero/HeroFaceController.js';
import type { HeroCharacterDefinition } from 'engine/hero/HeroCharacterDefinition.js';

function fixture() {
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ roughness: 0.8 });
    material.name = 'skin';
    const face = new THREE.Mesh(new THREE.BufferGeometry(), material);
    face.name = 'face';
    face.morphTargetDictionary = { jaw: 0, smile: 1, jawSmile: 2, unowned: 3 };
    face.morphTargetInfluences = [0, 0, 0, 0.4];
    root.add(face);
    const definition: HeroCharacterDefinition = {
        type: 'hero-character', version: 1, id: 'test',
        surfaces: [{ material: 'skin', kind: 'skin', roughness: 0.5, specularIntensity: 0.8, scatter: { color: '#ff6655', strength: 0.2 } }],
        controls: {
            jawOpen: [{ mesh: 'face', target: 'jaw', gain: 1 }],
            smile: [{ mesh: 'face', target: 'smile', gain: 1 }],
        },
        correctives: [{ drivers: ['jawOpen', 'smile'], binding: { mesh: 'face', target: 'jawSmile', gain: 1 } }],
    };
    return { root, material, face, definition };
}

test('face frame drives correctives, clears omitted controls and preserves unowned shapes', () => {
    const { root, face, definition } = fixture();
    const controller = new HeroFaceController(root, definition);
    controller.setFrame({ jawOpen: 0.5, smile: 0.8 });
    controller.advance(0.016, 0);
    expect(face.morphTargetInfluences).toEqual([0.5, 0.8, 0.4, 0.4]);
    controller.setFrame({ smile: 0.2 });
    controller.advance(0.016, 0);
    expect(face.morphTargetInfluences).toEqual([0, 0.2, 0, 0.4]);
});

test('smoothing is invariant to frame partition', () => {
    const a = fixture(), b = fixture();
    const ca = new HeroFaceController(a.root, a.definition), cb = new HeroFaceController(b.root, b.definition);
    ca.setFrame({ jawOpen: 1 }); cb.setFrame({ jawOpen: 1 });
    ca.advance(0.1, 0.08);
    for (let i = 0; i < 10; i++) cb.advance(0.01, 0.08);
    expect(a.face.morphTargetInfluences![0]).toBeCloseTo(b.face.morphTargetInfluences![0]!, 12);
});

test('rejects bad controls atomically and refuses missing/ambiguous geometry', () => {
    const { root, definition } = fixture();
    const controller = new HeroFaceController(root, definition);
    expect(() => controller.setFrame({ jawOpen: Number.NaN })).toThrow();
    expect(() => controller.setFrame({ missing: 0.5 })).toThrow();
    expect(() => controller.advance(-1, 0)).toThrow();
    definition.controls.jawOpen![0]!.target = 'absent';
    expect(() => new HeroFaceController(root, definition)).toThrow('Missing hero morph');
});

test('adoption owns material instances only and disposal restores input state', () => {
    const { root, face, material, definition } = fixture();
    const sourceDispose = jest.spyOn(material, 'dispose');
    const actor = new HeroCharacter(root, definition);
    expect(face.material).not.toBe(material);
    expect(() => new HeroCharacter(root, definition)).toThrow('already adopted');
    const replacementDispose = jest.spyOn(face.material as THREE.Material, 'dispose');
    actor.face.setFrame({ jawOpen: 1 }); actor.face.advance(0, 0);
    actor.dispose(); actor.dispose();
    expect(face.material).toBe(material);
    expect(face.morphTargetInfluences).toEqual([0, 0, 0, 0.4]);
    expect(sourceDispose).not.toHaveBeenCalled();
    expect(replacementDispose).toHaveBeenCalledTimes(1);
});

test('unassigned surfaces fail before mutation', () => {
    const { root, face, material, definition } = fixture();
    definition.surfaces[0]!.material = 'wrong';
    expect(() => new HeroCharacter(root, definition)).toThrow('Unassigned');
    expect(face.material).toBe(material);
});
