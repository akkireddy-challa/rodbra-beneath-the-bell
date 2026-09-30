import * as THREE from 'three';
import { authoredHipsHeight } from 'engine/loaders/AuthoredHipsHeight.js';
import { MixamoAnimationPlayer } from 'engine/MixamoAnimationPlayer.js';

describe('authored height frame ownership', () => {
    const frameCases = [-50, 0, 1200].flatMap(elevation =>
        [-1.2, -.35, 0, .45].flatMap(renderOffset =>
            [-.22, 0, .18].map(authored => ({ elevation, renderOffset, authored }))));

    it.each(frameCases)('isolates authored motion at $elevation with render offset $renderOffset and motion $authored',
        ({ elevation, renderOffset, authored }) => {
            const source = new MixamoAnimationPlayer();
            const rest = new THREE.Vector3(.1, 1, -.2);
            jest.spyOn(source, 'getRestHipsOffset').mockReturnValue(rest);
            for (const scale of [.01, 1, 2]) for (let direction = 0; direction < 8; direction++) {
                const frame = new THREE.Group();
                frame.position.set(3, elevation, -7); frame.rotation.y = direction * Math.PI / 4;
                frame.scale.setScalar(scale);
                const root = new THREE.Group(); root.position.y = renderOffset / scale; frame.add(root);
                jest.spyOn(source, 'getSkeletonRoot').mockReturnValue(root);
                const position = rest.clone().applyQuaternion(frame.getWorldQuaternion(new THREE.Quaternion()))
                    .add(root.getWorldPosition(new THREE.Vector3()));
                position.y += authored;
                const pose = new Map([['hips', { position, rotation: new THREE.Quaternion() }]]);
                const result = authoredHipsHeight(pose, source, frame, 'hips');
                expect(result?.offset).toBeCloseTo(authored, 9);
                expect(result?.position).toBe(position.y);
                expect(rest.toArray()).toEqual([.1, 1, -.2]);
            }
            source.dispose();
        });

    it.each([.01, 1, 2])('uses source rest in world metres, independent of target-parent scale %s', scale => {
        const frame = new THREE.Group(); frame.position.set(3, 40, -7); frame.rotation.y = .8; frame.scale.setScalar(scale);
        const source = new MixamoAnimationPlayer();
        jest.spyOn(source, 'getRestHipsOffset').mockReturnValue(new THREE.Vector3(0, 1, 0));
        const pose = new Map([['pelvis', { position: new THREE.Vector3(3, 41.12, -7), rotation: new THREE.Quaternion() }]]);
        expect(authoredHipsHeight(pose, source, frame, 'pelvis')!.offset).toBeCloseTo(.12, 9);
        frame.position.y += 5; pose.get('pelvis')!.position.y += 5;
        expect(authoredHipsHeight(pose, source, frame, 'pelvis')!.offset).toBeCloseTo(.12, 9);
        source.dispose();
    });

    it('falls back explicitly for missing source/hips and rejects non-finite displacement', () => {
        const source = new MixamoAnimationPlayer(), frame = new THREE.Group();
        const pose = new Map([['hips', { position: new THREE.Vector3(), rotation: new THREE.Quaternion() }]]);
        expect(authoredHipsHeight(pose, null, frame, 'hips')).toBeNull();
        expect(authoredHipsHeight(pose, undefined, frame, 'hips')).toBeNull();
        expect(authoredHipsHeight(pose, source, frame, 'hips')).toBeNull();
        jest.spyOn(source, 'getRestHipsOffset').mockReturnValue(new THREE.Vector3(0, 1, 0));
        expect(authoredHipsHeight(null, source, frame, 'hips')).toBeNull();
        expect(authoredHipsHeight(pose, source, frame, 'missing')).toBeNull();
        expect(authoredHipsHeight(pose, source, frame, undefined)).toBeNull();
        pose.get('hips')!.position.y = NaN;
        expect(authoredHipsHeight(pose, source, frame, 'hips')).toBeNull();
        source.dispose();
    });

    it.each([-Infinity, Infinity, NaN])('rejects non-finite source-root height %s', height => {
        const source = new MixamoAnimationPlayer(), root = new THREE.Group();
        root.position.y = height;
        jest.spyOn(source, 'getRestHipsOffset').mockReturnValue(new THREE.Vector3(0, 1, 0));
        jest.spyOn(source, 'getSkeletonRoot').mockReturnValue(root);
        const pose = new Map([['hips', { position: new THREE.Vector3(0, 1, 0), rotation: new THREE.Quaternion() }]]);
        expect(authoredHipsHeight(pose, source, new THREE.Group(), 'hips')).toBeNull();
        source.dispose();
    });
});
