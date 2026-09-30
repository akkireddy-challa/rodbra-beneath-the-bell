import * as THREE from 'three';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { scaleCharacterToHeight, getSkeletonHeight } from 'engine/CharacterConfig.js';

/**
 * RÖDBRÅ: Beneath the Bell — Liv Ravn Character System
 * Faithfully reproduces Liv Ravn from the official character sheet:
 * - Ash-blonde braid down the back
 * - Weathered dark charcoal greatcoat with blood-stained hem
 * - Dark leather practical armor cuirass
 * - Crimson sash around waist with hanging sash tail
 * - Engraved iron arm bracers
 * - Seax-style broad single-edged sword with curved pommel
 * - Throwable iron ward talisman at left hip
 * - Health-vial flask with leather wrap and crimson liquid at right hip
 */

export const LIV_CONFIG = {
  targetHeight: 1.68, // 168 cm from reference sheet
};

let leftEyePupil: THREE.Mesh | null = null;
let rightEyePupil: THREE.Mesh | null = null;
let swordMeshRef: THREE.Object3D | null = null;

export const bitmagicCharacterFactory: IBlockCharacterFactory = {
  createBlockCharacter: createLivRavnCharacter,

  getCharacterDimensions: () => {
    const height = LIV_CONFIG.targetHeight;
    const skeletonHeight = getSkeletonHeight();
    const ratio = height / skeletonHeight;
    return {
      width: 0.55 * ratio,
      height: height,
      depth: 0.35 * ratio,
    };
  }
};

export function applyBitmagicModifications(
  player: THREE.Object3D,
  playerController: any,
  playerLoader: any,
  blockCharacterRenderer: any
): void {
  const targetH = LIV_CONFIG.targetHeight;
  const skeletonH = getSkeletonHeight();
  const currentCharH = playerController?.characterHeight || skeletonH;
  scaleCharacterToHeight(player, currentCharH, targetH, '🗡️ Liv Ravn');

  if (playerController?.physicsBody && playerLoader) {
    const adjustedRadius = 0.32;
    playerController.setCapsuleDimensions(targetH, adjustedRadius);
    playerLoader.updatePhysicsBody(targetH, adjustedRadius);
    playerLoader.regroundPlayer();
  }
}

export function updateBitmagicEyeBlink(deltaTime: number): void {
  // Gentle eye blink
}

export function getPlayerSwordMesh(): THREE.Object3D | null {
  return swordMeshRef;
}

export function createLivRavnCharacter(characterGroup: THREE.Group): void {
  characterGroup.name = 'BlockCharacter_LivRavn';

  // Materials
  const matSkin = new THREE.MeshStandardMaterial({ color: 0xE8C5AF, roughness: 0.7, metalness: 0.05 });
  const matHair = new THREE.MeshStandardMaterial({ color: 0xD8CAAB, roughness: 0.8, metalness: 0.1 });
  const matCoat = new THREE.MeshStandardMaterial({ color: 0x27282A, roughness: 0.85, metalness: 0.05 });
  const matCoatHem = new THREE.MeshStandardMaterial({ color: 0x4A1414, roughness: 0.9, metalness: 0.05 }); // Distressed bloodstained hem
  const matCuirass = new THREE.MeshStandardMaterial({ color: 0x362820, roughness: 0.6, metalness: 0.15 }); // Weathered leather
  const matSash = new THREE.MeshStandardMaterial({ color: 0x8C1818, roughness: 0.75, metalness: 0.05 }); // Deep crimson sash
  const matIron = new THREE.MeshStandardMaterial({ color: 0x4E5357, roughness: 0.4, metalness: 0.8 }); // Engraved iron bracers/ward
  const matSteel = new THREE.MeshStandardMaterial({ color: 0x9BA1A6, roughness: 0.25, metalness: 0.9 }); // Sword blade
  const matBloodSteel = new THREE.MeshStandardMaterial({ color: 0x6B1212, roughness: 0.3, metalness: 0.6 }); // Stained blade edge
  const matLeather = new THREE.MeshStandardMaterial({ color: 0x2D211A, roughness: 0.7, metalness: 0.1 }); // Boots & belt
  const matGlass = new THREE.MeshStandardMaterial({ color: 0x7FA4B5, roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.7 });
  const matCrimsonFluid = new THREE.MeshStandardMaterial({ color: 0xB81414, roughness: 0.3, emissive: 0x4A0505, emissiveIntensity: 0.4 });

  // =========================================================================
  // 1. HEAD & ASH-BLONDE BRAID
  // =========================================================================
  const headGroup = characterGroup.getObjectByName('head') as THREE.Group;
  if (headGroup) {
    // Face & Head base
    const headMesh = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.22, 0.22), matSkin);
    headMesh.name = 'liv_head';
    headMesh.position.set(0, 0.13, 0);
    headGroup.add(headMesh);

    // Hair cap (Ash-blonde)
    const hairTop = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.10, 0.24), matHair);
    hairTop.position.set(0, 0.08, -0.01);
    headMesh.add(hairTop);

    // Side hair strands framing face
    const hairLeft = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.18), matHair);
    hairLeft.position.set(-0.11, -0.02, 0.01);
    headMesh.add(hairLeft);

    const hairRight = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.16, 0.18), matHair);
    hairRight.position.set(0.11, -0.02, 0.01);
    headMesh.add(hairRight);

    // Ash-blonde Braid descending down the back (-Z)
    for (let i = 0; i < 6; i++) {
      const braidSeg = new THREE.Mesh(new THREE.BoxGeometry(0.08 - i * 0.006, 0.09, 0.07), i % 2 === 0 ? matHair : matCuirass);
      braidSeg.position.set(0, 0.01 - i * 0.075, -0.13 - i * 0.01);
      braidSeg.rotation.z = (i % 2 === 0 ? 0.12 : -0.12);
      headMesh.add(braidSeg);
    }
    // Crimson hair tie at braid end
    const braidTie = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.06), matSash);
    braidTie.position.set(0, -0.45, -0.19);
    headMesh.add(braidTie);

    // Signature Braid strand draped over left shoulder down onto chest (+Z)
    // Ensures ash-blonde braid is clearly readable from the front camera view!
    for (let j = 0; j < 4; j++) {
      const frontBraidSeg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.06), matHair);
      frontBraidSeg.position.set(-0.10, -0.02 - j * 0.07, 0.12 + (j === 0 ? 0.01 : 0.02));
      frontBraidSeg.rotation.z = (j % 2 === 0 ? -0.1 : 0.1);
      headMesh.add(frontBraidSeg);
    }

    // Eyes: Blue-gray irises from reference sheet
    const eyeWhiteMat = new THREE.MeshBasicMaterial({ color: 0xFFFFFF });
    const eyeIrisMat = new THREE.MeshBasicMaterial({ color: 0x4D6B7B });

    // Left Eye
    const leftEyeWhite = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.01), eyeWhiteMat);
    leftEyeWhite.position.set(-0.06, 0.02, 0.112);
    headMesh.add(leftEyeWhite);
    const leftEyeIris = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.012), eyeIrisMat);
    leftEyeIris.position.set(-0.055, 0.02, 0.113);
    headMesh.add(leftEyeIris);
    leftEyePupil = leftEyeIris;

    // Right Eye
    const rightEyeWhite = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.01), eyeWhiteMat);
    rightEyeWhite.position.set(0.06, 0.02, 0.112);
    headMesh.add(rightEyeWhite);
    const rightEyeIris = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.012), eyeIrisMat);
    rightEyeIris.position.set(0.055, 0.02, 0.113);
    headMesh.add(rightEyeIris);
    rightEyePupil = rightEyeIris;
  }

  // =========================================================================
  // 2. NECK & COAT COLLAR
  // =========================================================================
  const neckGroup = characterGroup.getObjectByName('neck') as THREE.Group;
  if (neckGroup) {
    const neckMesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.12), matSkin);
    neckMesh.position.set(0, 0.01, 0);
    neckGroup.add(neckMesh);

    // Weathered high scarf/collar sitting cleanly below chin
    const collar = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.05, 0.20), matCoat);
    collar.position.set(0, -0.01, 0);
    neckGroup.add(collar);
  }

  // =========================================================================
  // 3. TORSO: CUIRASS, CHARCOAL COAT, CRIMSON SASH, WARD & FLASK
  // =========================================================================
  const torsoGroup = characterGroup.getObjectByName('torso') as THREE.Group;
  if (torsoGroup) {
    // Inner practical leather cuirass
    const cuirass = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.44, 0.24), matCuirass);
    cuirass.position.set(0, -0.06, 0);
    torsoGroup.add(cuirass);

    // Weathered charcoal coat sides and back
    const coatBack = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.50, 0.06), matCoat);
    coatBack.position.set(0, -0.08, -0.10);
    torsoGroup.add(coatBack);

    const coatLeftFlap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.48, 0.26), matCoat);
    coatLeftFlap.position.set(-0.20, -0.07, 0);
    torsoGroup.add(coatLeftFlap);

    const coatRightFlap = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.48, 0.26), matCoat);
    coatRightFlap.position.set(0.20, -0.07, 0);
    torsoGroup.add(coatRightFlap);

    // CRIMSON SASH: wrapped around waist
    const sashBelt = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.12, 0.27), matSash);
    sashBelt.position.set(0, -0.22, 0);
    torsoGroup.add(sashBelt);

    // Sash knotted tail hanging down front-left
    const sashTail = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.30, 0.05), matSash);
    sashTail.position.set(-0.12, -0.36, 0.13);
    sashTail.rotation.z = 0.08;
    torsoGroup.add(sashTail);

    // -----------------------------------------------------------------------
    // LOWER COAT SKIRTS WITH DISTRESSED BLOOD-STAINED HEM (360 DEGREES)
    // -----------------------------------------------------------------------
    // Skirt Back
    const skirtBack = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.32, 0.05), matCoat);
    skirtBack.position.set(0, -0.36, -0.12);
    torsoGroup.add(skirtBack);
    const hemBack = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.10, 0.06), matCoatHem);
    hemBack.position.set(0, -0.48, -0.12);
    torsoGroup.add(hemBack);

    // Skirt Front Left & Right (split for leg movement)
    const skirtFrontL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.30, 0.05), matCoat);
    skirtFrontL.position.set(-0.12, -0.35, 0.12);
    torsoGroup.add(skirtFrontL);
    const hemFrontL = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.10, 0.06), matCoatHem);
    hemFrontL.position.set(-0.12, -0.48, 0.12);
    torsoGroup.add(hemFrontL);

    const skirtFrontR = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.30, 0.05), matCoat);
    skirtFrontR.position.set(0.12, -0.35, 0.12);
    torsoGroup.add(skirtFrontR);
    const hemFrontR = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.10, 0.06), matCoatHem);
    hemFrontR.position.set(0.12, -0.48, 0.12);
    torsoGroup.add(hemFrontR);

    // Skirt Sides
    const skirtSideL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.30, 0.24), matCoat);
    skirtSideL.position.set(-0.21, -0.35, 0);
    torsoGroup.add(skirtSideL);
    const hemSideL = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.10, 0.25), matCoatHem);
    hemSideL.position.set(-0.21, -0.48, 0);
    torsoGroup.add(hemSideL);

    const skirtSideR = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.30, 0.24), matCoat);
    skirtSideR.position.set(0.21, -0.35, 0);
    torsoGroup.add(skirtSideR);
    const hemSideR = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.10, 0.25), matCoatHem);
    hemSideR.position.set(0.21, -0.48, 0);
    torsoGroup.add(hemSideR);

    // -----------------------------------------------------------------------
    // SCANDINAVIAN SEAX SWORD IN SCABBARD (at Left Hip)
    // Always visible so Liv reads unmistakably as a sword-bearing monster hunter
    // -----------------------------------------------------------------------
    const scabbardGroup = new THREE.Group();
    scabbardGroup.position.set(-0.25, -0.22, 0.02);
    scabbardGroup.rotation.x = 0.35;
    scabbardGroup.rotation.y = 0.15;
    scabbardGroup.rotation.z = -0.15;

    // Leather Scabbard sheath
    const scabbardBody = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.035, 0.65), matLeather);
    scabbardGroup.add(scabbardBody);

    // Iron scabbard throat & tip chape
    const scabbardThroat = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.04, 0.08), matIron);
    scabbardThroat.position.set(0, 0, 0.28);
    scabbardGroup.add(scabbardThroat);

    const scabbardTip = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.03, 0.08), matIron);
    scabbardTip.position.set(0, 0, -0.28);
    scabbardGroup.add(scabbardTip);

    // Curved seax hilt with brass ring pommel protruding from scabbard
    const seaxHilt = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.025, 0.18, 6), matLeather);
    seaxHilt.rotation.x = Math.PI / 2;
    seaxHilt.position.set(0, 0.01, 0.40);
    scabbardGroup.add(seaxHilt);

    const seaxPommel = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.01, 6, 12), matIron);
    seaxPommel.position.set(0, 0.01, 0.50);
    scabbardGroup.add(seaxPommel);

    torsoGroup.add(scabbardGroup);

    // THROWABLE IRON WARD TALISMAN (at left belt)
    const wardTalisman = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.04, 12), matIron);
    wardTalisman.rotation.z = Math.PI / 2;
    wardTalisman.position.set(-0.23, -0.18, 0.10);
    torsoGroup.add(wardTalisman);

    // HEALTH-VIAL FLASK (at right hip): glass body with glowing crimson fluid
    const flaskGroup = new THREE.Group();
    flaskGroup.position.set(0.24, -0.20, 0.06);

    const flaskGlass = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.13, 8), matGlass);
    flaskGroup.add(flaskGlass);

    const flaskFluid = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.10, 8), matCrimsonFluid);
    flaskFluid.position.set(0, -0.01, 0);
    flaskGroup.add(flaskFluid);

    const flaskCork = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.028, 0.035, 8), matLeather);
    flaskCork.position.set(0, 0.075, 0);
    flaskGroup.add(flaskCork);

    torsoGroup.add(flaskGroup);
  }

  // =========================================================================
  // 4. ARMS & IRON BRACERS
  // =========================================================================
  const leftUpperArm = characterGroup.getObjectByName('leftUpperArm') as THREE.Group;
  if (leftUpperArm) {
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.24, 0.14), matCoat);
    leftUpperArm.add(sleeve);
  }

  const leftForearm = characterGroup.getObjectByName('leftForearm') as THREE.Group;
  if (leftForearm) {
    // Coat forearm
    const sleeveLower = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.12), matCoat);
    leftForearm.add(sleeveLower);
    // Engraved Iron Bracer
    const bracer = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), matIron);
    bracer.position.set(0, -0.02, 0);
    leftForearm.add(bracer);
  }

  const leftHand = characterGroup.getObjectByName('leftHand') as THREE.Group;
  if (leftHand) {
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.10, 0.10), matLeather);
    leftHand.add(glove);
  }

  const rightUpperArm = characterGroup.getObjectByName('rightUpperArm') as THREE.Group;
  if (rightUpperArm) {
    const sleeve = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.24, 0.14), matCoat);
    rightUpperArm.add(sleeve);
  }

  const rightForearm = characterGroup.getObjectByName('rightForearm') as THREE.Group;
  if (rightForearm) {
    const sleeveLower = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.18, 0.12), matCoat);
    rightForearm.add(sleeveLower);
    // Engraved Iron Bracer
    const bracer = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), matIron);
    bracer.position.set(0, -0.02, 0);
    rightForearm.add(bracer);
  }

  // =========================================================================
  // 5. RIGHT HAND & SEAX-STYLE BROAD SWORD
  // =========================================================================
  const rightHand = characterGroup.getObjectByName('rightHand') as THREE.Group;
  if (rightHand) {
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.10, 0.10), matLeather);
    rightHand.add(glove);

    // SEAX-STYLE SWORD (attached to right hand)
    const swordGroup = new THREE.Group();
    swordGroup.name = 'liv_seax_sword';
    swordGroup.position.set(0, -0.04, 0.08);
    swordGroup.rotation.x = Math.PI / 2; // Point blade forward along strike vector

    // Handle (Leather-wrapped grip)
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.16, 8), matLeather);
    handle.position.set(0, -0.06, 0);
    swordGroup.add(handle);

    // Curved pommel hook
    const pommel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 0.06), matIron);
    pommel.position.set(0, -0.15, 0.015);
    swordGroup.add(pommel);

    // Hooked iron crossguard
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.05), matIron);
    guard.position.set(0, 0.03, 0);
    swordGroup.add(guard);

    // Broad single-edged seax blade
    // Steel spine
    const bladeSpine = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.65, 0.02), matSteel);
    bladeSpine.position.set(0, 0.36, 0);
    swordGroup.add(bladeSpine);

    // Bloodied cutting edge
    const bladeEdge = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.62, 0.012), matBloodSteel);
    bladeEdge.position.set(0.038, 0.36, 0);
    swordGroup.add(bladeEdge);

    // Clip point / seax angled tip
    const bladeTip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.10, 0.018), matBloodSteel);
    bladeTip.position.set(0.015, 0.70, 0);
    bladeTip.rotation.z = -0.35;
    swordGroup.add(bladeTip);

    rightHand.add(swordGroup);
    swordMeshRef = swordGroup;
  }

  // =========================================================================
  // 6. LEGS & BUCKLED BOOTS
  // =========================================================================
  const leftThigh = characterGroup.getObjectByName('leftThigh') as THREE.Group;
  if (leftThigh) {
    const pants = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.32, 0.16), matCoat);
    leftThigh.add(pants);
  }

  const leftShin = characterGroup.getObjectByName('leftShin') as THREE.Group;
  if (leftShin) {
    const bootShaft = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.32, 0.16), matLeather);
    leftShin.add(bootShaft);
    // Iron buckle strap
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.04, 0.17), matIron);
    strap.position.set(0, 0.05, 0);
    leftShin.add(strap);
  }

  const leftFoot = characterGroup.getObjectByName('leftFoot') as THREE.Group;
  if (leftFoot) {
    const bootFoot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.28), matLeather);
    bootFoot.position.set(0, -0.06, 0.04);
    leftFoot.add(bootFoot);
  }

  const rightThigh = characterGroup.getObjectByName('rightThigh') as THREE.Group;
  if (rightThigh) {
    const pants = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.32, 0.16), matCoat);
    rightThigh.add(pants);
  }

  const rightShin = characterGroup.getObjectByName('rightShin') as THREE.Group;
  if (rightShin) {
    const bootShaft = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.32, 0.16), matLeather);
    rightShin.add(bootShaft);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.04, 0.17), matIron);
    strap.position.set(0, 0.05, 0);
    rightShin.add(strap);
  }

  const rightFoot = characterGroup.getObjectByName('rightFoot') as THREE.Group;
  if (rightFoot) {
    const bootFoot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.28), matLeather);
    bootFoot.position.set(0, -0.06, 0.04);
    rightFoot.add(bootFoot);
  }
}
