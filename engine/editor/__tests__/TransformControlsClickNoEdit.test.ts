/**
 * Clicking the transform gizmo without dragging is not an edit.
 *
 * `mouseUp` used to call `markSceneChanges` unconditionally, so selecting an object in the
 * Editor tab and clicking it (or its gizmo) again put it in the modified set — and leaving the
 * tab then wrote an edit-history entry the user never made. The hover/mode-switch `change`
 * events likewise rewrote the untouched object from the pivot.
 *
 * @jest-environment jsdom
 */
import * as THREE from 'three';

jest.mock('three/addons/controls/TransformControls.js', () => {
    const three = require('three') as typeof THREE;
    class FakeTransformControls extends three.EventDispatcher<Record<string, Record<string, unknown>>> {
        dragging = false;
        object: THREE.Object3D | undefined;
        private helper = new three.Object3D();
        setSpace(): void {}
        setMode(): void {}
        setSize(): void {}
        getHelper(): THREE.Object3D { return this.helper; }
        attach(object: THREE.Object3D): void { this.object = object; }
        detach(): void { this.object = undefined; }
        dispose(): void {}
    }
    return { TransformControls: FakeTransformControls };
});

import { TransformControlsManager } from '../TransformControlsManager.js';

type FakeControls = THREE.EventDispatcher<Record<string, Record<string, unknown>>> & {
    dragging: boolean;
    object: THREE.Object3D | undefined;
};

function setup(): { controls: FakeControls; object: THREE.Mesh; markSceneChanges: jest.Mock } {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const renderer = { domElement: document.createElement('canvas') } as unknown as THREE.WebGLRenderer;
    const markSceneChanges = jest.fn();
    const manager = new TransformControlsManager(scene, camera, renderer, { markSceneChanges });

    const object = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    object.position.set(3, 1, -2);
    object.rotation.set(0, 3.5, 0); // outside ±π/2: a quaternion round trip re-encodes it
    scene.add(object);
    manager.attach(object);

    const controls = (manager as unknown as { transformControls: FakeControls }).transformControls;
    return { controls, object, markSceneChanges };
}

/** TransformControls' own order: dragging flips (with a 'change'), then mouseDown. */
function press(controls: FakeControls): void {
    controls.dragging = true;
    controls.dispatchEvent({ type: 'change' });
    controls.dispatchEvent({ type: 'mouseDown' });
}

function release(controls: FakeControls): void {
    controls.dispatchEvent({ type: 'mouseUp' });
    controls.dragging = false;
    controls.dispatchEvent({ type: 'change' });
}

describe('TransformControlsManager', () => {
    it('does not mark the object modified for a click that never drags', () => {
        const { controls, markSceneChanges } = setup();
        press(controls);
        release(controls);
        expect(markSceneChanges).not.toHaveBeenCalled();
    });

    it('marks the object modified when the drag moved it', () => {
        const { controls, object, markSceneChanges } = setup();
        press(controls);
        controls.object!.position.x += 2;
        controls.dispatchEvent({ type: 'change' });
        release(controls);
        expect(markSceneChanges).toHaveBeenCalledWith(object);
        expect(object.position.x).toBeCloseTo(5);
    });

    it('leaves the object untouched on hover/mode-switch change events', () => {
        const { controls, object } = setup();
        const rotationBefore = object.rotation.clone();
        controls.dispatchEvent({ type: 'change' });
        expect(object.rotation.equals(rotationBefore)).toBe(true);
    });
});
