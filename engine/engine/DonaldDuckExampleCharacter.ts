import * as THREE from 'three';
import { scaleCharacterToHeight, getSkeletonHeight } from 'engine/CharacterConfig.js';
// Material classes via tagging: the block-character conversion turns each tag
// into the shared classed material at the resolved quality — feathers read
// plush ('fur'), beak and feet glossy toon ('plastic'), clothes soft ('cloth'),
// eyes wet ('gem'). On low quality everything is Lambert, the classic look.
import { classedPartStandardMaterial } from 'engine/npc/customization/blockPartCaches.js';

/**
 * Complete Donald Duck character system
 * Everything Donald Duck related is contained in this file for easy AI modification
 */

// Donald Duck character configuration
export const DONALD_DUCK_CONFIG = {
  targetHeight: 1.3, // meters
};

/**
 * Apply all Donald Duck modifications to a player character
 * This includes visual scaling, physics updates, and re-grounding
 */
export function applyDonaldDuckModifications(
  player: THREE.Object3D, 
  playerController: any, 
  playerLoader: any, 
  blockCharacterBuilder: any
): void {
  console.log('🦆 Applying complete Donald Duck modifications...');
  
  // 1. Scale character to Donald Duck height
  scaleToDonaldDuckHeight(player, playerController);
  
  // 2. Update physics and re-ground
  updatePhysicsForDonaldDuck(player, playerController, playerLoader);
  
  console.log('✅ All Donald Duck modifications applied successfully');
}

/**
 * Scale the character to Donald Duck's target height (1.3m)
 * 
 * Uses the shared scaling utility from CharacterConfig which handles the logic
 * of scaling from the current characterHeight (set by PlayerLoader from world.json)
 * to the target height.
 */
function scaleToDonaldDuckHeight(player: THREE.Object3D, playerController: any): void {
  const donaldDuckHeight = DONALD_DUCK_CONFIG.targetHeight;
  const skeletonHeight = getSkeletonHeight();
  
  // Get the current character height that PlayerLoader scaled to
  const currentCharacterHeight = playerController?.characterHeight || skeletonHeight;

  // Use shared utility to scale the character
  scaleCharacterToHeight(player, currentCharacterHeight, donaldDuckHeight, '🦆');
}

/**
 * Update physics body and re-ground the character for Donald Duck dimensions
 */
function updatePhysicsForDonaldDuck(player: THREE.Object3D, playerController: any, playerLoader: any): void {
  const donaldDuckHeight = DONALD_DUCK_CONFIG.targetHeight;
  const skeletonHeight = getSkeletonHeight();
  
  // Get the current character height from PlayerController to calculate radius ratio
  const currentCharacterHeight = playerController.characterHeight || skeletonHeight;
  const heightRatio = donaldDuckHeight / currentCharacterHeight;
  
  // Update PlayerController dimensions
  playerController.setCharacterHeight(donaldDuckHeight);
  const adjustedRadius = playerController.capsuleRadius * heightRatio;
  playerController.setCapsuleDimensions(donaldDuckHeight, adjustedRadius);
  
  // Update PlayerLoader dimensions and recreate physics body
  if (playerLoader && typeof playerLoader.updateCapsuleDimensions === 'function') {
    playerLoader.updateCapsuleDimensions(donaldDuckHeight, adjustedRadius);
    
    // Recreate the physics body with the new dimensions
    if (typeof playerLoader.recreatePhysicsBody === 'function') {
      playerLoader.recreatePhysicsBody(player);
      // Update PlayerController reference to the new physics body
      playerController.playerBody = playerLoader.getPlayerBody();
    }
  }
  
  // Re-ground the character
  if (typeof playerController.regroundCharacter === 'function') {
    playerController.regroundCharacter(donaldDuckHeight);
  }
  
  console.log(`🦆 Physics updated: height=${donaldDuckHeight}m, radius=${adjustedRadius.toFixed(3)}m`);
}

/**
 * Procedural Donald Duck visual mesh generation using Three.js APIs directly
 * This code can be modified by AI to create different character variations
 */
export function createDonaldDuckBlockCharacter(characterGroup: THREE.Group) {
  // Set character-specific name
  characterGroup.name = 'BlockCharacter_Donald_Duck';
  
  // All positions and scales are arbitrary and can be adjusted for better proportions.
  // Using BoxGeometry for blocky primitives. Y-axis up, Z-axis forward.
  // All measurements in meters - actual character scale

  // Head (white head with orange beak, blue hat, black eyes)
  const headGroup = characterGroup.getObjectByName('head') as THREE.Group;

  // Create main head mesh
  const headMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.4, 0.3),
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  headMesh.name = 'donald_head_main';
  // Position head so bone is at 1/5 from bottom (move head up)
  const headHeight = 0.4;
  const boneOffsetFromBottom = 3 * headHeight / 5;
  headMesh.position.set(0, boneOffsetFromBottom, 0);
  headGroup.add(headMesh);

  // Orange beak as child of head - position relative to head mesh
  const beakMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.06, 0.18),
    classedPartStandardMaterial('plastic', { color: 'orange' })
  );
  beakMesh.name = 'donald_beak';
  // Position relative to head mesh
  beakMesh.position.set(0, -0.10, 0.24);
  headMesh.add(beakMesh);

  // Blue hat base as child of head - position relative to head mesh
  const hatBaseMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.264, 0.036, 0.264),
    classedPartStandardMaterial('cloth', { color: 'blue' })
  );
  hatBaseMesh.name = 'donald_hat_base';
  hatBaseMesh.position.set(0, 0.22, 0);
  headMesh.add(hatBaseMesh);

  // Blue hat top as child of hat base - position relative to hat base
  const hatTopMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.096, 0.18),
    classedPartStandardMaterial('cloth', { color: 'blue' })
  );
  hatTopMesh.name = 'donald_hat_top';
  hatTopMesh.position.set(0, 0.03, 0); // Position relative to hat base
  hatBaseMesh.add(hatTopMesh); // Child of hat base, which is child of head

  // Left eye as child of head - position relative to head mesh
  const leftEyeMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.048, 0.072, 0.024),
    classedPartStandardMaterial('gem', { color: 'black' })
  );
  leftEyeMesh.name = 'donald_eye_left';
  leftEyeMesh.position.set(-0.072, 0.06, 0.18);
  headMesh.add(leftEyeMesh);

  // Right eye as child of head - position relative to head mesh
  const rightEyeMesh = leftEyeMesh.clone();
  rightEyeMesh.name = 'donald_eye_right';
  rightEyeMesh.position.x = 0.072;
  headMesh.add(rightEyeMesh);

  // Neck (short white neck)
  const neckGroup = characterGroup.getObjectByName('neck') as THREE.Group;
  const neckMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.1, 0.12),
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  neckMesh.name = 'donald_neck';
  neckMesh.position.set(0, 0.05, 0);
  neckGroup.add(neckMesh);

  // Torso (blue sailor shirt over white body, with red bow and tail)
  const torsoGroup = characterGroup.getObjectByName('torso') as THREE.Group;

  // Main torso body - hierarchical structure with sub-elements as children
  const torsoBodyMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.4, 0.2),
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  torsoBodyMesh.name = 'donald_torso_body';
  // Position torso to extend up to shoulder/neck level (move torso up)
  torsoBodyMesh.position.set(0, -0.10, 0); // Moved up from -1.25 to -0.5
  torsoBodyMesh.rotation.y = Math.PI;
  torsoGroup.add(torsoBodyMesh);

  // Blue sailor shirt as child of torso body
  const torsoShirtMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.40, 0.22),
    classedPartStandardMaterial('cloth', { color: 'blue' })
  );
  torsoShirtMesh.name = 'donald_sailor_shirt';
  torsoShirtMesh.position.set(0, 0.20, 0); // Position relative to torso body
  torsoBodyMesh.add(torsoShirtMesh);

  const bowMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.05, 0.03),
    classedPartStandardMaterial('cloth', { color: 'red' })
  );
  bowMesh.name = 'donald_bow_tie';
  bowMesh.position.set(0, 0.30, -0.11); // Front of torso
  torsoBodyMesh.add(bowMesh);

  const tailMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.1, 0.15),
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  tailMesh.name = 'donald_tail';
  tailMesh.position.set(0, -0.15, 0.125); // Back of torso
  tailMesh.rotation.set(0, 0, Math.PI / 6); // Slight tilt for tail
  torsoBodyMesh.add(tailMesh);

  // Left Upper Arm (white) - spans from shoulder to elbow bone
  // Note: These dimensions are actual centimeter measurements for the character
  const leftUpperArmGroup = characterGroup.getObjectByName('leftUpperArm') as THREE.Group;
  const leftUpperArmMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.25, 0.1), // Actual arm measurements: width=0.1, height=0.25, depth=0.1
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  leftUpperArmMesh.name = 'donald_arm_upper_left';
  leftUpperArmMesh.position.set(0, 0.0, 0); // Position relative to bone midpoint
  leftUpperArmGroup.add(leftUpperArmMesh);

  // Left Forearm (white) - spans from elbow to wrist bone
  // Note: These dimensions are actual centimeter measurements for the character
  const leftForearmGroup = characterGroup.getObjectByName('leftForearm') as THREE.Group;
  const leftForearmMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.15, 0.1), // Actual forearm measurements: width=0.1, height=0.2, depth=0.1
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  leftForearmMesh.name = 'donald_arm_forearm_left';
  leftForearmMesh.position.set(0, 0.0, 0); // Position relative to bone midpoint
  leftForearmGroup.add(leftForearmMesh);

  // Left Hand (white, slightly wider) - single wrist bone
  const leftHandGroup = characterGroup.getObjectByName('leftHand') as THREE.Group;
  const leftHandMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.1, 0.12), // Actual hand measurements: width=0.12, height=0.1, depth=0.12
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  leftHandMesh.name = 'donald_hand_left';
  leftHandMesh.position.set(0, 0.05, 0); // Position relative to wrist bone
  leftHandGroup.add(leftHandMesh);

  // Right Upper Arm (white, mirrored) - spans from shoulder to elbow bone
  // Note: These dimensions are actual centimeter measurements for the character
  const rightUpperArmGroup = characterGroup.getObjectByName('rightUpperArm') as THREE.Group;
  const rightUpperArmMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.25, 0.1), // Actual arm measurements: width=0.1, height=0.25, depth=0.1
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  rightUpperArmMesh.name = 'donald_arm_upper_right';
  rightUpperArmMesh.position.set(0, 0.0, 0); // Position relative to bone midpoint
  rightUpperArmGroup.add(rightUpperArmMesh);

  // Right Forearm (white) - spans from elbow to wrist bone
  // Note: These dimensions are actual centimeter measurements for the character
  const rightForearmGroup = characterGroup.getObjectByName('rightForearm') as THREE.Group;
  const rightForearmMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.15, 0.1), // Actual forearm measurements: width=0.1, height=0.2, depth=0.1
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  rightForearmMesh.name = 'donald_arm_forearm_right';
  rightForearmMesh.position.set(0, 0.0, 0); // Position relative to bone midpoint
  rightForearmGroup.add(rightForearmMesh);

  // Right Hand (white, slightly wider) - single wrist bone
  const rightHandGroup = characterGroup.getObjectByName('rightHand') as THREE.Group;
  const rightHandMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.1, 0.12), // Actual hand measurements: width=0.12, height=0.1, depth=0.12
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  rightHandMesh.name = 'donald_hand_right';
  rightHandMesh.position.set(0, 0.05, 0); // Position relative to wrist bone
  rightHandGroup.add(rightHandMesh);

  // Left Thigh (white upper leg) - spans from hip to knee bone
  // Note: These dimensions are actual centimeter measurements for the character
  const leftThighGroup = characterGroup.getObjectByName('leftThigh') as THREE.Group;
  const leftThighMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.35, 0.15), // Increased size to better cover hip-to-knee distance
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  leftThighMesh.name = 'donald_leg_thigh_left';
  leftThighMesh.position.set(0, 0.0, 0); // Position relative to bone midpoint
  leftThighGroup.add(leftThighMesh);

  // Left Shin (orange lower leg) - spans from knee to ankle bone
  // Note: These dimensions are actual centimeter measurements for the character
  const leftShinGroup = characterGroup.getObjectByName('leftShin') as THREE.Group;
  const leftShinMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.40, 0.12), // Increased size to better cover knee-to-ankle distance
    classedPartStandardMaterial('plastic', { color: 'orange' })
  );
  leftShinMesh.name = 'donald_leg_shin_left';
  leftShinMesh.position.set(0, 0.05, 0); // Position relative to bone midpoint
  leftShinGroup.add(leftShinMesh);

  // Left Foot (orange webbed foot approximation) - positioned at toe base bone by engine
  const leftFootGroup = characterGroup.getObjectByName('leftFoot') as THREE.Group;
  const leftFootMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.30, 0.08), // Swapped dimensions: width=0.15, depth=0.30, height=0.08 (Y-axis aligned with bone)
    classedPartStandardMaterial('plastic', { color: 'orange' })
  );
  leftFootMesh.name = 'donald_foot_left';
  // No static rotation - correction applied dynamically in BlockCharacterRenderer
  leftFootMesh.position.set(0, 0.15, 0); // Position adjusted for new orientation
  leftFootGroup.add(leftFootMesh);

  // Right Thigh (white upper leg) - spans from hip to knee bone
  // Note: These dimensions are actual centimeter measurements for the character
  const rightThighGroup = characterGroup.getObjectByName('rightThigh') as THREE.Group;
  const rightThighMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.35, 0.15), // Increased size to better cover hip-to-knee distance
    classedPartStandardMaterial('fur', { color: 'white' })
  );
  rightThighMesh.name = 'donald_leg_thigh_right';
  rightThighMesh.position.set(0, 0.0, 0); // Position relative to bone midpoint
  rightThighGroup.add(rightThighMesh);

  // Right Shin (orange lower leg) - spans from knee to ankle bone
  // Note: These dimensions are actual centimeter measurements for the character
  const rightShinGroup = characterGroup.getObjectByName('rightShin') as THREE.Group;
  const rightShinMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.40, 0.12), // Increased size to better cover knee-to-ankle distance
    classedPartStandardMaterial('plastic', { color: 'orange' })
  );
  rightShinMesh.name = 'donald_leg_shin_right';
  rightShinMesh.position.set(0, 0.05, 0); // Position relative to bone midpoint
  rightShinGroup.add(rightShinMesh);

  // Right Foot (orange webbed foot approximation) - positioned at toe base bone by engine
  const rightFootGroup = characterGroup.getObjectByName('rightFoot') as THREE.Group;
  const rightFootMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.15, 0.30, 0.08), // Swapped dimensions: width=0.15, depth=0.30, height=0.08 (Y-axis aligned with bone)
    classedPartStandardMaterial('plastic', { color: 'orange' })
  );
  rightFootMesh.name = 'donald_foot_right';
  // No static rotation - correction applied dynamically in BlockCharacterRenderer
  rightFootMesh.position.set(0, 0.15, 0); // Position adjusted for new orientation
  rightFootGroup.add(rightFootMesh);

  // Enable shadow casting and receiving for all meshes in the character
  characterGroup.traverse((child) => {
    if ((child as any).isMesh) {
      const mesh = child as THREE.Mesh;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  console.log('Donald Duck block character created with shadow casting enabled');
}
