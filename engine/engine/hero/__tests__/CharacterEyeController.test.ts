import { Group, Mesh, Quaternion, Vector3 } from 'three';
import { CharacterEyeController } from 'engine/hero/CharacterEyeController.js';

test('gaze composes with fitted orientation, stays absolute, and preserves body and eye scale', () => {
    const root = new Group(), eye = new Group();
    eye.userData = { characterEye: true, forwardAxis: '+Z' };
    eye.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    eye.scale.setScalar(.7); root.add(eye);
    const rest = eye.quaternion.clone();
    const controller = new CharacterEyeController(root);
    const frame = { yaw: .2, pitch: 0, blinkLeft: 0, blinkRight: 0 };
    controller.setFrame(frame);
    const expected = rest.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .2));
    expect(eye.quaternion.angleTo(expected)).toBeCloseTo(0);
    controller.setFrame(frame);
    expect(eye.quaternion.angleTo(expected)).toBeCloseTo(0);
    expect(eye.scale.toArray()).toEqual([.7, .7, .7]);
    expect(root.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    controller.reset(); expect(eye.quaternion.angleTo(rest)).toBeCloseTo(0);
});

test('left and right eyelids stay independent and invalid frames cannot partially mutate the face', () => {
    const root = new Group(), lids = new Mesh(); root.add(lids);
    lids.morphTargetDictionary = { eyeBlinkLeft: 0, eyeBlinkRight: 1, smile: 2 };
    lids.morphTargetInfluences = [0, 0, .3];
    const controller = new CharacterEyeController(root);
    controller.setFrame({ yaw: 0, pitch: 0, blinkLeft: 1, blinkRight: .2 });
    expect(lids.morphTargetInfluences).toEqual([1, .2, .3]);
    expect(() => controller.setFrame({ yaw: NaN, pitch: 0, blinkLeft: 0, blinkRight: 0 })).toThrow();
    expect(lids.morphTargetInfluences).toEqual([1, .2, .3]);
    controller.reset(); expect(lids.morphTargetInfluences).toEqual([0, 0, .3]);
});

test('authored gaze-follow lids use local pitch and yield independently to blinks', () => {
    const root = new Group(), lids = new Mesh(); root.add(lids);
    lids.morphTargetDictionary = { eyeLidLookUpLeft: 0, eyeLidLookDownLeft: 1, eyeLidLookUpRight: 2, eyeLidLookDownRight: 3, smile: 4 };
    lids.morphTargetInfluences = [0, 0, 0, 0, .4];
    const controller = new CharacterEyeController(root);
    controller.setFrame({ yaw: .1, pitch: -.175, blinkLeft: 1, blinkRight: .2 });
    expect(lids.morphTargetInfluences).toEqual([0, 0, .4, 0, .4]);
    controller.setFrame({ yaw: 0, pitch: .35, blinkLeft: 0, blinkRight: 0 });
    expect(lids.morphTargetInfluences).toEqual([0, 1, 0, 1, .4]);
    controller.reset(); expect(lids.morphTargetInfluences).toEqual([0, 0, 0, 0, .4]);
});
