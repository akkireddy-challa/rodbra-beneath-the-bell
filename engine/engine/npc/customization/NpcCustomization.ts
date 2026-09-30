import * as THREE from 'three';
import type { IBlockCharacterFactory } from 'engine/IBlockCharacterFactory.js';
import { classedPartStandardMaterial, getSharedBoxGeometry } from 'engine/npc/customization/blockPartCaches.js';

/**
 * 🎨 NPC Customization System
 * 
 * ⚠️ CRITICAL FOR AI AGENTS: This system makes it EASY to customize NPC appearance!
 * 
 * **This is a FULLY FLEXIBLE system - you can create ANY customization you want!**
 * 
 * Use this system to create NPCs with:
 * - Different colors (skin, clothing, accessories) - ANY hex color
 * - Different body shapes (size, proportions) - ANY dimensions
 * - Custom features (ears, horns, tails, beards, etc.) - ANY combination
 * - Clothing items (hats, shirts, pants, shoes, belts) - ANY combination
 * - 20+ Accessories (glasses, jewelry, bags, protective gear, etc.) - ANY combination
 * 
 * ## Quick Start
 * 
 * ## See NpcCustomizationExamples.ts for 5 SAMPLE TEMPLATES!
 * 
 * **IMPORTANT: The examples are TEMPLATES, not a limited selection!**
 * - Use them as-is if they match your needs
 * - Modify them to create variations
 * - Use them as examples to create completely custom characters
 * - Mix and match elements from different examples
 * - Create ANY combination you can imagine!
 * 
 * ## Available Accessories (20+ options):
 * 
 * **Head Accessories:**
 * - Hats: cap, tophat, crown, helmet, beanie, hood, bandana-hat, cowboy, beret, visor (10 types)
 * - Glasses: round, square, aviator (with optional lens color)
 * - Beard: short, medium, long, goatee, mustache, full
 * - Bandana, Mask, Earrings
 * 
 * **Body Accessories:**
 * - Belt (with buckle, adjustable width)
 * - Necklace (with pendant)
 * - Backpack (with straps)
 * - Cape
 * - Scarf
 * - Badge/Pin
 * 
 * **Arm Accessories:**
 * - Shoulder pads
 * - Elbow pads
 * - Gloves
 * - Bracelet
 * - Watch (appears on left hand)
 * - Ring
 * 
 * **Leg Accessories:**
 * - Knee pads
 * - Bandage
 * 
 * **Foot Accessories:**
 * - Shoes: sneakers, boots, sandals, dress (4 types)
 * - Boots (via bootsColor)
 */

/**
 * Color configuration for NPC parts
 */
export interface NpcColorConfig {
    /** Main color (hex number, e.g., 0xFF0000 for red) */
    color: number;
    /** Optional: Roughness (0-1, default: 0.5) */
    roughness?: number;
    /** Optional: Metalness (0-1, default: 0.0) */
    metalness?: number;
    /** Optional: Emissive color for glowing effects */
    emissive?: number;
    /** Optional: Emissive intensity (0-1, default: 0) */
    emissiveIntensity?: number;
}

/**
 * Body shape configuration
 */
export interface NpcBodyShapeConfig {
    /** Character height in meters (default: 1.75) */
    height?: number;
    /** Character width in meters (default: 0.5) */
    width?: number;
    /** Character depth in meters (default: 0.35) */
    depth?: number;
    /** Head size multiplier (default: 1.0) */
    headSize?: number;
    /** Torso size multiplier (default: 1.0) */
    torsoSize?: number;
    /** Limb size multiplier (default: 1.0) */
    limbSize?: number;
}

/**
 * Ear configuration
 */
export interface NpcEarConfig {
    /** Ear type: 'pointed', 'round', 'floppy', 'none' */
    type: 'pointed' | 'round' | 'floppy' | 'none';
    /** Ear color */
    color: number;
    /** Ear size multiplier (default: 1.0) */
    size?: number;
}

/**
 * Horn configuration
 */
export interface NpcHornConfig {
    /** Horn type: 'small', 'medium', 'large', 'curved', 'none' */
    type: 'small' | 'medium' | 'large' | 'curved' | 'none';
    /** Horn color */
    color: number;
    /** Horn size multiplier (default: 1.0) */
    size?: number;
}

/**
 * Tail configuration
 */
export interface NpcTailConfig {
    /** Tail type: 'short', 'medium', 'long', 'fluffy', 'none' */
    type: 'short' | 'medium' | 'long' | 'fluffy' | 'none';
    /** Tail color */
    color: number;
    /** Tail size multiplier (default: 1.0) */
    size?: number;
}

/**
 * Beard configuration
 */
export interface NpcBeardConfig {
    /** Beard type: 'short', 'medium', 'long', 'goatee', 'mustache', 'full', 'none' */
    type: 'short' | 'medium' | 'long' | 'goatee' | 'mustache' | 'full' | 'none';
    /** Beard color */
    color: number;
    /** Beard size multiplier (default: 1.0) */
    size?: number;
}

/**
 * Belt configuration
 */
export interface NpcBeltConfig {
    /** Belt color (undefined = no belt) */
    color?: number;
    /** Belt width multiplier (default: 1.0) */
    width?: number;
}

/**
 * Glasses configuration
 */
export interface NpcGlassesConfig {
    /** Glasses type: 'round', 'square', 'aviator', 'none' */
    type: 'round' | 'square' | 'aviator' | 'none';
    /** Frame color */
    color: number;
    /** Lens color (default: transparent/clear) */
    lensColor?: number;
}

/**
 * Shoes configuration
 */
export interface NpcShoesConfig {
    /** Shoes color (undefined = uses bootsColor or skin) */
    color?: number;
    /** Shoes type: 'sneakers', 'boots', 'sandals', 'dress', 'none' */
    type?: 'sneakers' | 'boots' | 'sandals' | 'dress' | 'none';
}

/**
 * Accessories configuration
 */
export interface NpcAccessoriesConfig {
    /** Glasses configuration */
    glasses?: NpcGlassesConfig;
    /** Necklace (color, undefined = no necklace) */
    necklace?: number;
    /** Bracelet (color, undefined = no bracelet) */
    bracelet?: number;
    /** Watch (color, undefined = no watch) */
    watch?: number;
    /** Backpack (color, undefined = no backpack) */
    backpack?: number;
    /** Cape (color, undefined = no cape) */
    cape?: number;
    /** Scarf (color, undefined = no scarf) */
    scarf?: number;
    /** Gloves (color, undefined = no gloves) */
    gloves?: number;
    /** Shoulder pads (color, undefined = no shoulder pads) */
    shoulderPads?: number;
    /** Knee pads (color, undefined = no knee pads) */
    kneePads?: number;
    /** Elbow pads (color, undefined = no elbow pads) */
    elbowPads?: number;
    /** Bandana (color, undefined = no bandana) */
    bandana?: number;
    /** Mask (color, undefined = no mask) */
    mask?: number;
    /** Earrings (color, undefined = no earrings) */
    earrings?: number;
    /** Ring (color, undefined = no ring) */
    ring?: number;
    /** Badge/Pin (color, undefined = no badge) */
    badge?: number;
    /** Bandage (color, undefined = no bandage) */
    bandage?: number;
}

/**
 * Clothing configuration
 */
export interface NpcClothingConfig {
    /** Shirt color (undefined = no shirt) */
    shirtColor?: number;
    /** Pants color (undefined = no pants) */
    pantsColor?: number;
    /** Hat color (undefined = no hat) */
    hatColor?: number;
    /** Hat type: 'cap', 'tophat', 'crown', 'helmet', 'beanie', 'hood', 'bandana-hat', 'cowboy', 'beret', 'visor' */
    hatType?: 'cap' | 'tophat' | 'crown' | 'helmet' | 'beanie' | 'hood' | 'bandana-hat' | 'cowboy' | 'beret' | 'visor';
    /** Boots color (undefined = no boots) */
    bootsColor?: number;
    /** Belt configuration */
    belt?: NpcBeltConfig;
    /** Shoes configuration */
    shoes?: NpcShoesConfig;
    /** Accessories configuration */
    accessories?: NpcAccessoriesConfig;
}

/**
 * Feature configuration
 */
export interface NpcFeaturesConfig {
    /** Ear configuration */
    ears?: NpcEarConfig;
    /** Horn configuration */
    horns?: NpcHornConfig;
    /** Tail configuration */
    tail?: NpcTailConfig;
    /** Beard configuration */
    beard?: NpcBeardConfig;
    /** Eye color (default: 0x000000 for black) */
    eyeColor?: number;
    /** Use visor-style eyes (triangular, no white sclera) - for helmets like stormtrooper */
    visorEyes?: boolean;
    /** Add sparkles/decorations (default: false) */
    sparkles?: boolean;
}

/**
 * Complete NPC customization configuration
 */
export interface NpcCustomizationConfig {
    /** Skin color configuration */
    skinColor: NpcColorConfig | number; // Can be just a number for simplicity
    /** Clothing configuration */
    clothing?: NpcClothingConfig;
    /** Body shape configuration */
    bodyShape?: NpcBodyShapeConfig;
    /** Feature configuration */
    features?: NpcFeaturesConfig;
    /** Accent color for decorations (default: uses clothing color) */
    accentColor?: number;
}

/**
 * Helper to create a color config from a number or config object
 */
function normalizeColorConfig(color: NpcColorConfig | number): NpcColorConfig {
    if (typeof color === 'number') {
        return { color };
    }
    return color;
}

/**
 * Create a customized NPC character factory
 * 
 * ⚠️⚠️⚠️ CRITICAL WARNING - FOR HUMANOIDS ONLY! ⚠️⚠️⚠️
 * 
 * THIS FUNCTION CREATES HUMANOIDS (2-LEGGED BIPEDAL CHARACTERS)!
 * 
 * ❌ DO NOT USE THIS FOR ANIMALS (dogs, wolves, cats, etc.)!
 * ❌ DO NOT USE THIS FOR 4-LEGGED CREATURES!
 * 
 * ✅ USE THIS FOR: Humans, humanoids, bipedal characters
 * ❌ DO NOT USE FOR: Dogs, wolves, cats, horses, any 4-legged animals
 * 
 * For animals, use: createAnimalBlockCharacterFactory() + AnimalVisualSystem
 * 
 * @param config - Customization configuration
 * @returns IBlockCharacterFactory that creates HUMANOID NPCs (2-legged, bipedal)
 */
export function createCustomizedNpcFactory(config: NpcCustomizationConfig): IBlockCharacterFactory {
    // ⚠️⚠️⚠️ CRITICAL WARNING: This function creates 2-LEGGED HUMANOIDS!
    // ⚠️⚠️⚠️ DO NOT USE THIS FOR: dogs, cats, horses, pigs, cows, bears, wolves, etc.!
    // Note: For animals (4-legged creatures), use createAnimal() from engine/animal/index.js instead
    
    const skinConfig = normalizeColorConfig(config.skinColor);
    const bodyShape = config.bodyShape || {};
    const features = config.features || {};
    const clothing = config.clothing || {};
    const accessories = clothing.accessories || {};
    const accentColor = config.accentColor || clothing.shirtColor || skinConfig.color;

    // Calculate dimensions
    const height = bodyShape.height ?? 1.75;
    const width = bodyShape.width ?? 0.5;
    const depth = bodyShape.depth ?? 0.35;

    return {
        createBlockCharacter: (characterGroup: THREE.Group) => {
            createCustomizedCharacter(
                characterGroup,
                skinConfig,
                clothing,
                bodyShape,
                features,
                accentColor,
                accessories
            );
        },

        getCharacterDimensions: () => ({
            width,
            height,
            depth
        })
    };
}

/**
 * Create a customized character mesh
 */
function createCustomizedCharacter(
    characterGroup: THREE.Group,
    skinConfig: NpcColorConfig,
    clothing: NpcClothingConfig,
    bodyShape: NpcBodyShapeConfig,
    features: NpcFeaturesConfig,
    accentColor: number,
    accessories: NpcAccessoriesConfig
): void {
    const headSize = bodyShape.headSize ?? 1.0;
    const torsoSize = bodyShape.torsoSize ?? 1.0;
    const limbSize = bodyShape.limbSize ?? 1.0;

    // Create skin material
    const skinMaterial = new THREE.MeshStandardMaterial({
        color: skinConfig.color,
        roughness: skinConfig.roughness ?? 0.5,
        metalness: skinConfig.metalness ?? 0.0,
        emissive: skinConfig.emissive ?? 0x000000,
        emissiveIntensity: skinConfig.emissiveIntensity ?? 0.0
    });

    // Create clothing material
    const createClothingMaterial = (color: number) => classedPartStandardMaterial('cloth', {
        color,
        roughness: 0.6,
        metalness: 0.0
    });

    // HEAD
    const headGroup = characterGroup.getObjectByName('head') as THREE.Group;
    if (headGroup) {
        const headMesh = new THREE.Mesh(
            getSharedBoxGeometry(0.45 * headSize, 0.4 * headSize, 0.4 * headSize),
            skinMaterial.clone()
        );
        headMesh.position.set(0, 0.24, 0);
        headMesh.castShadow = true;
        headGroup.add(headMesh);

        // Eyes
        const eyeColor = features.eyeColor ?? 0x000000;
        
        if (features.visorEyes) {
            // Visor-style eyes (triangular, like stormtrooper helmet)
            // These are just solid shapes, no white sclera
            const visorMaterial = classedPartStandardMaterial('glass', { color: eyeColor });
            
            // Left eye - triangular visor shape (wider at top, narrower at bottom)
            const leftVisor = new THREE.Mesh(
                getSharedBoxGeometry(0.12, 0.1, 0.06),
                visorMaterial
            );
            leftVisor.position.set(-0.1, 0.1, 0.22);
            leftVisor.rotation.z = 0.15; // Slight angle for menacing look
            headMesh.add(leftVisor);
            
            // Right eye - mirrored
            const rightVisor = new THREE.Mesh(
                getSharedBoxGeometry(0.12, 0.1, 0.06),
                visorMaterial
            );
            rightVisor.position.set(0.1, 0.1, 0.22);
            rightVisor.rotation.z = -0.15; // Opposite angle
            headMesh.add(rightVisor);
        } else {
            // Normal eyes with white sclera and colored pupil
            const leftEye = new THREE.Mesh(
                getSharedBoxGeometry(0.1, 0.12, 0.05),
                new THREE.MeshStandardMaterial({ color: 0xFFFFFF })
            );
            leftEye.position.set(-0.1, 0.08, 0.22);
            headMesh.add(leftEye);

            const leftPupil = new THREE.Mesh(
                getSharedBoxGeometry(0.05, 0.06, 0.03),
                new THREE.MeshStandardMaterial({ color: eyeColor })
            );
            leftPupil.position.set(0, 0, 0.04);
            leftEye.add(leftPupil);

            const rightEye = leftEye.clone();
            rightEye.position.x = 0.1;
            headMesh.add(rightEye);
        }

        // Ears
        if (features.ears && features.ears.type !== 'none') {
            createEars(headMesh, features.ears);
        }

        // Horns
        if (features.horns && features.horns.type !== 'none') {
            createHorns(headMesh, features.horns);
        }

        // Hat
        if (clothing.hatColor && clothing.hatType) {
            createHat(headMesh, clothing.hatColor, clothing.hatType);
        }

        // Beard
        if (features.beard && features.beard.type !== 'none') {
            createBeard(headMesh, features.beard);
        }

        // Glasses
        if (accessories.glasses && accessories.glasses.type !== 'none') {
            createGlasses(headMesh, accessories.glasses);
        }

        // Bandana
        if (accessories.bandana) {
            createBandana(headMesh, accessories.bandana);
        }

        // Mask
        if (accessories.mask) {
            createMask(headMesh, accessories.mask);
        }

        // Earrings
        if (accessories.earrings) {
            createEarrings(headMesh, accessories.earrings);
        }

        // Sparkles
        if (features.sparkles) {
            createSparkles(headMesh, accentColor);
        }
    }

    // NECK
    const neckGroup = characterGroup.getObjectByName('neck') as THREE.Group;
    if (neckGroup) {
        const neckMesh = new THREE.Mesh(
            getSharedBoxGeometry(0.2, 0.12, 0.18),
            skinMaterial.clone()
        );
        neckMesh.position.set(0, 0.06, 0);
        neckMesh.castShadow = true;
        neckGroup.add(neckMesh);
    }

    // TORSO
    const torsoGroup = characterGroup.getObjectByName('torso') as THREE.Group;
    if (torsoGroup) {
        const torsoMesh = new THREE.Mesh(
            getSharedBoxGeometry(0.5 * torsoSize, 0.6 * torsoSize, 0.35 * torsoSize),
            skinMaterial.clone()
        );
        torsoMesh.position.set(0, -0.1, 0);
        torsoMesh.rotation.y = Math.PI;
        torsoMesh.castShadow = true;
        torsoGroup.add(torsoMesh);

        // Shirt
        if (clothing.shirtColor) {
            const shirtMaterial = createClothingMaterial(clothing.shirtColor);
            if (shirtMaterial) {
                const shirtMesh = new THREE.Mesh(
                    getSharedBoxGeometry(0.52 * torsoSize, 0.4 * torsoSize, 0.37 * torsoSize),
                    shirtMaterial
                );
                shirtMesh.position.set(0, 0.1, 0.01);
                torsoMesh.add(shirtMesh);
            }
        }

        // Belt
        if (clothing.belt && clothing.belt.color) {
            createBelt(torsoMesh, clothing.belt);
        }

        // Necklace
        if (accessories.necklace) {
            createNecklace(torsoMesh, accessories.necklace);
        }

        // Backpack
        if (accessories.backpack) {
            createBackpack(torsoMesh, accessories.backpack);
        }

        // Cape
        if (accessories.cape) {
            createCape(torsoMesh, accessories.cape);
        }

        // Scarf
        if (accessories.scarf) {
            createScarf(torsoMesh, accessories.scarf);
        }

        // Badge/Pin
        if (accessories.badge) {
            createBadge(torsoMesh, accessories.badge);
        }
    }

    // ARMS
    ['leftUpperArm', 'leftForearm', 'rightUpperArm', 'rightForearm'].forEach(partName => {
        const partGroup = characterGroup.getObjectByName(partName) as THREE.Group;
        if (partGroup) {
            const armMesh = new THREE.Mesh(
                getSharedBoxGeometry(0.15 * limbSize, 0.25 * limbSize, 0.15 * limbSize),
                skinMaterial.clone()
            );
            armMesh.position.set(0, -0.125, 0);
            armMesh.castShadow = true;
            partGroup.add(armMesh);

            // Shoulder pads (on upper arms)
            if (accessories.shoulderPads && partName.includes('UpperArm')) {
                createShoulderPad(armMesh, accessories.shoulderPads);
            }

            // Elbow pads (on forearms)
            if (accessories.elbowPads && partName.includes('Forearm')) {
                createElbowPad(armMesh, accessories.elbowPads);
            }
        }
    });

    // HANDS
    ['leftHand', 'rightHand'].forEach(partName => {
        const partGroup = characterGroup.getObjectByName(partName) as THREE.Group;
        if (partGroup) {
            const handMesh = new THREE.Mesh(
                getSharedBoxGeometry(0.18 * limbSize, 0.12 * limbSize, 0.15 * limbSize),
                skinMaterial.clone()
            );
            handMesh.position.set(0, -0.06, 0);
            handMesh.castShadow = true;
            partGroup.add(handMesh);

            // Gloves
            if (accessories.gloves) {
                createGlove(handMesh, accessories.gloves);
            }

            // Bracelet (on wrist area)
            if (accessories.bracelet) {
                createBracelet(handMesh, accessories.bracelet);
            }

            // Watch (on left hand)
            if (accessories.watch && partName === 'leftHand') {
                createWatch(handMesh, accessories.watch);
            }

            // Ring
            if (accessories.ring) {
                createRing(handMesh, accessories.ring);
            }
        }
    });

    // LEGS
    ['leftThigh', 'leftShin', 'rightThigh', 'rightShin'].forEach(partName => {
        const partGroup = characterGroup.getObjectByName(partName) as THREE.Group;
        if (partGroup) {
            // Leg meshes should extend from joint to joint
            // Thigh: from hip to knee, Shin: from knee to ankle
            const isThigh = partName.includes('Thigh');
            const legHeight = isThigh ? 0.35 * limbSize : 0.4 * limbSize; // Longer to span joints
            const legMesh = new THREE.Mesh(
                getSharedBoxGeometry(0.18 * limbSize, legHeight, 0.18 * limbSize),
                skinMaterial.clone()
            );
            // Center the mesh along the bone (Y-axis)
            legMesh.position.set(0, 0, 0);
            legMesh.castShadow = true;
            partGroup.add(legMesh);

            // Pants
            if (clothing.pantsColor && (partName.includes('Thigh') || partName.includes('Shin'))) {
                const pantsMaterial = createClothingMaterial(clothing.pantsColor);
                if (pantsMaterial) {
                    const pantsHeight = isThigh ? 0.36 * limbSize : 0.41 * limbSize; // Slightly larger than leg
                    const pantsMesh = new THREE.Mesh(
                        getSharedBoxGeometry(0.19 * limbSize, pantsHeight, 0.19 * limbSize),
                        pantsMaterial
                    );
                    pantsMesh.position.set(0, 0, 0.01);
                    legMesh.add(pantsMesh);
                }
            }

            // Knee pads (on shins)
            if (accessories.kneePads && partName.includes('Shin')) {
                createKneePad(legMesh, accessories.kneePads);
            }

            // Bandage (on any leg part)
            if (accessories.bandage) {
                createBandage(legMesh, accessories.bandage);
            }
        }
    });

    // FEET
    ['leftFoot', 'rightFoot'].forEach(partName => {
        const partGroup = characterGroup.getObjectByName(partName) as THREE.Group;
        if (partGroup) {
            // Use shoes config if available, otherwise fall back to bootsColor or skin
            const footColor = clothing.shoes?.color || clothing.bootsColor;
            const footMaterial = footColor
                ? createClothingMaterial(footColor)
                : skinMaterial.clone();

            // Foot geometry: width (X), length along bone (Y), height (Z)
            const footMesh = new THREE.Mesh(
                getSharedBoxGeometry(0.2 * limbSize, 0.5 * limbSize, 0.12 * limbSize),
                footMaterial || skinMaterial.clone()
            );
            footMesh.position.set(0, -0.125, 0);
            footMesh.castShadow = true;
            partGroup.add(footMesh);

            // Custom shoes styling if specified
            if (clothing.shoes && clothing.shoes.type && clothing.shoes.type !== 'none') {
                createShoes(footMesh, clothing.shoes);
            }
        }
    });

    // TAIL
    if (torsoGroup && features.tail && features.tail.type !== 'none') {
        createTail(torsoGroup, features.tail);
    }

}

/**
 * Create ears on the head
 */
function createEars(headMesh: THREE.Mesh, earConfig: NpcEarConfig): void {
    const size = earConfig.size ?? 1.0;
    const earMaterial = new THREE.MeshStandardMaterial({ color: earConfig.color });

    [-0.15, 0.15].forEach(x => {
        let earGeometry: THREE.BoxGeometry;
        
        switch (earConfig.type) {
            case 'pointed':
                earGeometry = getSharedBoxGeometry(0.06 * size, 0.15 * size, 0.06 * size);
                break;
            case 'round':
                earGeometry = getSharedBoxGeometry(0.08 * size, 0.12 * size, 0.08 * size);
                break;
            case 'floppy':
                earGeometry = getSharedBoxGeometry(0.1 * size, 0.2 * size, 0.05 * size);
                break;
            default:
                return;
        }

        const ear = new THREE.Mesh(earGeometry, earMaterial);
        ear.position.set(x, 0.2, -0.15);
        if (earConfig.type === 'floppy') {
            ear.rotation.z = -0.3;
        }
        headMesh.add(ear);
    });
}

/**
 * Create horns on the head
 */
function createHorns(headMesh: THREE.Mesh, hornConfig: NpcHornConfig): void {
    const size = hornConfig.size ?? 1.0;
    const hornMaterial = classedPartStandardMaterial('stone', { color: hornConfig.color });

    [-0.12, 0.12].forEach(x => {
        let hornGeometry: THREE.BoxGeometry;
        
        switch (hornConfig.type) {
            case 'small':
                hornGeometry = getSharedBoxGeometry(0.05 * size, 0.1 * size, 0.05 * size);
                break;
            case 'medium':
                hornGeometry = getSharedBoxGeometry(0.06 * size, 0.15 * size, 0.06 * size);
                break;
            case 'large':
                hornGeometry = getSharedBoxGeometry(0.08 * size, 0.2 * size, 0.08 * size);
                break;
            case 'curved':
                hornGeometry = getSharedBoxGeometry(0.06 * size, 0.18 * size, 0.06 * size);
                break;
            default:
                return;
        }

        const horn = new THREE.Mesh(hornGeometry, hornMaterial);
        horn.position.set(x, 0.26, 0);
        if (hornConfig.type === 'curved') {
            horn.rotation.z = -0.2;
        }
        headMesh.add(horn);
    });
}

/**
 * Create a hat on the head
 * Supports: cap, tophat, crown, helmet, beanie, hood, bandana-hat, cowboy, beret, visor
 */
function createHat(headMesh: THREE.Mesh, hatColor: number, hatType: string): void {
    const hatMaterial = classedPartStandardMaterial('cloth', { color: hatColor });

    let hatGeometry: THREE.BoxGeometry;
    let hatPosition: THREE.Vector3;
    let hatRotation: THREE.Euler;

    switch (hatType) {
        case 'cap':
            hatGeometry = getSharedBoxGeometry(0.5, 0.15, 0.4);
            hatPosition = new THREE.Vector3(0, 0.25, 0);
            hatRotation = new THREE.Euler(0, 0, 0);
            break;
        case 'tophat':
            hatGeometry = getSharedBoxGeometry(0.3, 0.25, 0.3);
            hatPosition = new THREE.Vector3(0, 0.3, 0);
            hatRotation = new THREE.Euler(0, 0, 0);
            break;
        case 'crown':
            hatGeometry = getSharedBoxGeometry(0.4, 0.2, 0.35);
            hatPosition = new THREE.Vector3(0, 0.28, 0);
            hatRotation = new THREE.Euler(0, 0, 0);
            break;
        case 'helmet':
            hatGeometry = getSharedBoxGeometry(0.48, 0.3, 0.38);
            hatPosition = new THREE.Vector3(0, 0.22, 0);
            hatRotation = new THREE.Euler(0, 0, 0);
            break;
        case 'beanie':
            hatGeometry = getSharedBoxGeometry(0.48, 0.2, 0.38);
            hatPosition = new THREE.Vector3(0, 0.24, 0);
            hatRotation = new THREE.Euler(0, 0, 0);
            break;
        case 'hood':
            hatGeometry = getSharedBoxGeometry(0.5, 0.25, 0.4);
            hatPosition = new THREE.Vector3(0, 0.23, -0.05);
            hatRotation = new THREE.Euler(-0.2, 0, 0);
            break;
        case 'bandana-hat':
            hatGeometry = getSharedBoxGeometry(0.5, 0.12, 0.4);
            hatPosition = new THREE.Vector3(0, 0.25, 0);
            hatRotation = new THREE.Euler(0, 0, 0);
            break;
        case 'cowboy':
            hatGeometry = getSharedBoxGeometry(0.45, 0.08, 0.45);
            hatPosition = new THREE.Vector3(0, 0.28, 0);
            hatRotation = new THREE.Euler(0, 0, 0);
            // Add brim
            const brim = new THREE.Mesh(
                getSharedBoxGeometry(0.6, 0.02, 0.6),
                hatMaterial
            );
            brim.position.set(0, 0.24, 0);
            headMesh.add(brim);
            break;
        case 'beret':
            hatGeometry = getSharedBoxGeometry(0.4, 0.06, 0.4);
            hatPosition = new THREE.Vector3(0, 0.26, 0);
            hatRotation = new THREE.Euler(0.3, 0, 0);
            break;
        case 'visor':
            hatGeometry = getSharedBoxGeometry(0.45, 0.1, 0.35);
            hatPosition = new THREE.Vector3(0, 0.25, 0.1);
            hatRotation = new THREE.Euler(0, 0, 0);
            break;
        default:
            return;
    }

    const hat = new THREE.Mesh(hatGeometry, hatMaterial);
    hat.position.copy(hatPosition);
    hat.rotation.copy(hatRotation);
    headMesh.add(hat);
}

/**
 * Create sparkles/decorations
 */
function createSparkles(headMesh: THREE.Mesh, color: number): void {
    const sparklePositions = [
        { x: -0.15, y: 0.25, z: 0.1 },
        { x: 0.15, y: 0.2, z: 0.1 },
        { x: 0, y: 0.15, z: 0.18 }
    ];

    sparklePositions.forEach((pos, index) => {
        const sparkle = new THREE.Mesh(
            getSharedBoxGeometry(0.03, 0.03, 0.01),
            classedPartStandardMaterial('gem', {
                color,
                emissive: color,
                emissiveIntensity: 0.3,
                roughness: 0.1,
                metalness: 0.8
            })
        );
        sparkle.position.set(pos.x, pos.y, pos.z);
        if (index % 2 === 0) {
            sparkle.rotation.z = Math.PI / 4;
        }
        headMesh.add(sparkle);
    });
}

/**
 * Create a tail
 */
function createTail(torsoGroup: THREE.Group, tailConfig: NpcTailConfig): void {
    const size = tailConfig.size ?? 1.0;
    const tailMaterial = classedPartStandardMaterial('fur', { color: tailConfig.color });

    let tailGeometry: THREE.BoxGeometry;
    
    switch (tailConfig.type) {
        case 'short':
            tailGeometry = getSharedBoxGeometry(0.08 * size, 0.15 * size, 0.08 * size);
            break;
        case 'medium':
            tailGeometry = getSharedBoxGeometry(0.1 * size, 0.25 * size, 0.1 * size);
            break;
        case 'long':
            tailGeometry = getSharedBoxGeometry(0.12 * size, 0.35 * size, 0.12 * size);
            break;
        case 'fluffy':
            tailGeometry = getSharedBoxGeometry(0.15 * size, 0.2 * size, 0.15 * size);
            break;
        default:
            return;
    }

    const tail = new THREE.Mesh(tailGeometry, tailMaterial);
    tail.position.set(0, -0.3, -0.2);
    tail.rotation.x = Math.PI / 6;
    torsoGroup.add(tail);
}

/**
 * Create a beard on the head
 */
function createBeard(headMesh: THREE.Mesh, beardConfig: NpcBeardConfig): void {
    const size = beardConfig.size ?? 1.0;
    const beardMaterial = classedPartStandardMaterial('fur', { color: beardConfig.color });

    let beardGeometry: THREE.BoxGeometry;
    let beardPosition: THREE.Vector3;
    
    switch (beardConfig.type) {
        case 'short':
            beardGeometry = getSharedBoxGeometry(0.25 * size, 0.08 * size, 0.1 * size);
            beardPosition = new THREE.Vector3(0, -0.1, 0.15);
            break;
        case 'medium':
            beardGeometry = getSharedBoxGeometry(0.25 * size, 0.12 * size, 0.12 * size);
            beardPosition = new THREE.Vector3(0, -0.12, 0.15);
            break;
        case 'long':
            beardGeometry = getSharedBoxGeometry(0.25 * size, 0.18 * size, 0.12 * size);
            beardPosition = new THREE.Vector3(0, -0.16, 0.15);
            break;
        case 'goatee':
            beardGeometry = getSharedBoxGeometry(0.12 * size, 0.1 * size, 0.1 * size);
            beardPosition = new THREE.Vector3(0, -0.1, 0.15);
            break;
        case 'mustache':
            beardGeometry = getSharedBoxGeometry(0.2 * size, 0.04 * size, 0.08 * size);
            beardPosition = new THREE.Vector3(0, -0.05, 0.18);
            break;
        case 'full':
            beardGeometry = getSharedBoxGeometry(0.3 * size, 0.2 * size, 0.12 * size);
            beardPosition = new THREE.Vector3(0, -0.15, 0.15);
            break;
        default:
            return;
    }

    const beard = new THREE.Mesh(beardGeometry, beardMaterial);
    beard.position.copy(beardPosition);
    headMesh.add(beard);
}

/**
 * Create glasses on the head
 */
function createGlasses(headMesh: THREE.Mesh, glassesConfig: NpcGlassesConfig): void {
    const frameMaterial = classedPartStandardMaterial('metal', { color: glassesConfig.color });
    const lensColor = glassesConfig.lensColor ?? 0x87CEEB; // Light blue tint
    
    let frameGeometry: THREE.BoxGeometry;
    let lensGeometry: THREE.BoxGeometry;
    
    switch (glassesConfig.type) {
        case 'round':
            frameGeometry = getSharedBoxGeometry(0.22, 0.08, 0.02);
            lensGeometry = getSharedBoxGeometry(0.18, 0.06, 0.01);
            break;
        case 'square':
            frameGeometry = getSharedBoxGeometry(0.22, 0.08, 0.02);
            lensGeometry = getSharedBoxGeometry(0.18, 0.06, 0.01);
            break;
        case 'aviator':
            frameGeometry = getSharedBoxGeometry(0.24, 0.06, 0.02);
            lensGeometry = getSharedBoxGeometry(0.2, 0.04, 0.01);
            break;
        default:
            return;
    }

    // Left frame
    const leftFrame = new THREE.Mesh(frameGeometry, frameMaterial);
    leftFrame.position.set(-0.11, 0.05, 0.2);
    headMesh.add(leftFrame);

    // Right frame
    const rightFrame = new THREE.Mesh(frameGeometry, frameMaterial);
    rightFrame.position.set(0.11, 0.05, 0.2);
    headMesh.add(rightFrame);

    // Bridge
    const bridge = new THREE.Mesh(
        getSharedBoxGeometry(0.04, 0.02, 0.02),
        frameMaterial
    );
    bridge.position.set(0, 0.05, 0.2);
    headMesh.add(bridge);

    // Lenses
    const lensMaterial = classedPartStandardMaterial('glass', {
        color: lensColor,
        transparent: true,
        opacity: 0.3
    });
    const leftLens = new THREE.Mesh(lensGeometry, lensMaterial);
    leftLens.position.set(-0.11, 0.05, 0.205);
    headMesh.add(leftLens);

    const rightLens = new THREE.Mesh(lensGeometry, lensMaterial);
    rightLens.position.set(0.11, 0.05, 0.205);
    headMesh.add(rightLens);
}

/**
 * Create a belt on the torso
 */
function createBelt(torsoMesh: THREE.Mesh, beltConfig: NpcBeltConfig): void {
    const width = beltConfig.width ?? 1.0;
    const beltMaterial = classedPartStandardMaterial('leather', { color: beltConfig.color });
    
    const belt = new THREE.Mesh(
        getSharedBoxGeometry(0.52, 0.08 * width, 0.38),
        beltMaterial
    );
    belt.position.set(0, -0.15, 0.01);
    torsoMesh.add(belt);

    // Buckle
    const buckle = new THREE.Mesh(
        getSharedBoxGeometry(0.08, 0.1 * width, 0.05),
        classedPartStandardMaterial('gold', { color: 0xFFD700, metalness: 0.8 })
    );
    buckle.position.set(0, -0.15, 0.22);
    torsoMesh.add(buckle);
}

/**
 * Create shoes on feet
 */
function createShoes(footMesh: THREE.Mesh, shoesConfig: NpcShoesConfig): void {
    const shoeMaterial = classedPartStandardMaterial('leather', {
        color: shoesConfig.color || 0x000000
    });

    switch (shoesConfig.type) {
        case 'sneakers':
            // Add laces detail
            const laces = new THREE.Mesh(
                getSharedBoxGeometry(0.15, 0.02, 0.01),
                classedPartStandardMaterial('cloth', { color: 0xFFFFFF })
            );
            laces.position.set(0, 0.15, 0.05);
            footMesh.add(laces);
            break;
        case 'boots':
            // Taller boot
            const bootTop = new THREE.Mesh(
                getSharedBoxGeometry(0.22, 0.1, 0.14),
                shoeMaterial
            );
            bootTop.position.set(0, 0.2, 0);
            footMesh.add(bootTop);
            break;
        case 'sandals':
            // Straps
            const strap1 = new THREE.Mesh(
                getSharedBoxGeometry(0.15, 0.02, 0.01),
                shoeMaterial
            );
            strap1.position.set(0, 0.1, 0.05);
            footMesh.add(strap1);
            break;
        case 'dress':
            // Shiny dress shoes
            const dressShoeMaterial = classedPartStandardMaterial('leather', {
                color: shoesConfig.color || 0x000000,
                metalness: 0.3,
                roughness: 0.2
            });
            footMesh.material = dressShoeMaterial;
            break;
    }
}

/**
 * Create a necklace on the torso
 */
function createNecklace(torsoMesh: THREE.Mesh, color: number): void {
    const necklaceMaterial = classedPartStandardMaterial('gold', {
        color,
        metalness: 0.7,
        roughness: 0.2
    });
    
    const necklace = new THREE.Mesh(
        getSharedBoxGeometry(0.3, 0.04, 0.04),
        necklaceMaterial
    );
    necklace.position.set(0, 0.25, 0.18);
    torsoMesh.add(necklace);

    // Pendant
    const pendant = new THREE.Mesh(
        getSharedBoxGeometry(0.04, 0.06, 0.02),
        necklaceMaterial
    );
    pendant.position.set(0, 0.22, 0.19);
    torsoMesh.add(pendant);
}

/**
 * Create a backpack on the torso
 */
function createBackpack(torsoMesh: THREE.Mesh, color: number): void {
    const backpackMaterial = classedPartStandardMaterial('cloth', { color });
    
    const backpack = new THREE.Mesh(
        getSharedBoxGeometry(0.3, 0.4, 0.2),
        backpackMaterial
    );
    backpack.position.set(0, -0.05, -0.25);
    torsoMesh.add(backpack);

    // Straps
    const strapMaterial = classedPartStandardMaterial('leather', { color: 0x000000 });
    [-0.15, 0.15].forEach(x => {
        const strap = new THREE.Mesh(
            getSharedBoxGeometry(0.04, 0.3, 0.02),
            strapMaterial
        );
        strap.position.set(x, 0.05, -0.15);
        torsoMesh.add(strap);
    });
}

/**
 * Create a cape on the torso
 */
function createCape(torsoMesh: THREE.Mesh, color: number): void {
    const capeMaterial = classedPartStandardMaterial('cloth', { color });
    
    const cape = new THREE.Mesh(
        getSharedBoxGeometry(0.4, 0.5, 0.05),
        capeMaterial
    );
    cape.position.set(0, -0.1, -0.25);
    torsoMesh.add(cape);
}

/**
 * Create a scarf on the torso
 */
function createScarf(torsoMesh: THREE.Mesh, color: number): void {
    const scarfMaterial = classedPartStandardMaterial('cloth', { color });
    
    const scarf = new THREE.Mesh(
        getSharedBoxGeometry(0.35, 0.1, 0.08),
        scarfMaterial
    );
    scarf.position.set(0, 0.2, 0.15);
    torsoMesh.add(scarf);
}

/**
 * Create a badge/pin on the torso
 */
function createBadge(torsoMesh: THREE.Mesh, color: number): void {
    const badgeMaterial = classedPartStandardMaterial('metal', {
        color,
        metalness: 0.8,
        roughness: 0.2
    });
    
    const badge = new THREE.Mesh(
        getSharedBoxGeometry(0.06, 0.06, 0.02),
        badgeMaterial
    );
    badge.position.set(0.15, 0.15, 0.19);
    torsoMesh.add(badge);
}

/**
 * Create gloves on hands
 */
function createGlove(handMesh: THREE.Mesh, color: number): void {
    const gloveMaterial = classedPartStandardMaterial('leather', { color });
    
    const glove = new THREE.Mesh(
        getSharedBoxGeometry(0.2, 0.14, 0.17),
        gloveMaterial
    );
    glove.position.set(0, 0, 0.01);
    handMesh.add(glove);
}

/**
 * Create a bracelet on hand
 */
function createBracelet(handMesh: THREE.Mesh, color: number): void {
    const braceletMaterial = classedPartStandardMaterial('gold', {
        color,
        metalness: 0.7
    });
    
    const bracelet = new THREE.Mesh(
        getSharedBoxGeometry(0.2, 0.03, 0.03),
        braceletMaterial
    );
    bracelet.position.set(0, -0.08, 0);
    handMesh.add(bracelet);
}

/**
 * Create a watch on hand
 */
function createWatch(handMesh: THREE.Mesh, color: number): void {
    const watchMaterial = classedPartStandardMaterial('metal', {
        color,
        metalness: 0.9
    });
    
    const watch = new THREE.Mesh(
        getSharedBoxGeometry(0.12, 0.08, 0.02),
        watchMaterial
    );
    watch.position.set(0, -0.08, 0.08);
    handMesh.add(watch);

    // Watch face
    const face = new THREE.Mesh(
        getSharedBoxGeometry(0.08, 0.06, 0.01),
        new THREE.MeshStandardMaterial({ color: 0x000000 })
    );
    face.position.set(0, -0.08, 0.09);
    handMesh.add(face);
}

/**
 * Create a ring on hand
 */
function createRing(handMesh: THREE.Mesh, color: number): void {
    const ringMaterial = classedPartStandardMaterial('gold', {
        color,
        metalness: 0.9
    });
    
    const ring = new THREE.Mesh(
        getSharedBoxGeometry(0.06, 0.02, 0.02),
        ringMaterial
    );
    ring.position.set(0, -0.05, 0.1);
    handMesh.add(ring);
}

/**
 * Create shoulder pads on arms
 */
function createShoulderPad(armMesh: THREE.Mesh, color: number): void {
    const padMaterial = classedPartStandardMaterial('plastic', { color });
    
    const pad = new THREE.Mesh(
        getSharedBoxGeometry(0.2, 0.15, 0.18),
        padMaterial
    );
    pad.position.set(0, 0.1, 0);
    armMesh.add(pad);
}

/**
 * Create elbow pads on forearms
 */
function createElbowPad(armMesh: THREE.Mesh, color: number): void {
    const padMaterial = classedPartStandardMaterial('plastic', { color });
    
    const pad = new THREE.Mesh(
        getSharedBoxGeometry(0.18, 0.1, 0.16),
        padMaterial
    );
    pad.position.set(0, -0.1, 0);
    armMesh.add(pad);
}

/**
 * Create knee pads on legs
 */
function createKneePad(legMesh: THREE.Mesh, color: number): void {
    const padMaterial = classedPartStandardMaterial('plastic', { color });
    
    const pad = new THREE.Mesh(
        getSharedBoxGeometry(0.2, 0.12, 0.2),
        padMaterial
    );
    pad.position.set(0, -0.1, 0);
    legMesh.add(pad);
}

/**
 * Create a bandana on head
 */
function createBandana(headMesh: THREE.Mesh, color: number): void {
    const bandanaMaterial = classedPartStandardMaterial('cloth', { color });
    
    const bandana = new THREE.Mesh(
        getSharedBoxGeometry(0.5, 0.1, 0.05),
        bandanaMaterial
    );
    bandana.position.set(0, 0.15, -0.15);
    headMesh.add(bandana);
}

/**
 * Create a mask on head
 */
function createMask(headMesh: THREE.Mesh, color: number): void {
    const maskMaterial = classedPartStandardMaterial('cloth', { color });
    
    const mask = new THREE.Mesh(
        getSharedBoxGeometry(0.3, 0.12, 0.08),
        maskMaterial
    );
    mask.position.set(0, -0.05, 0.2);
    headMesh.add(mask);
}

/**
 * Create earrings on head
 */
function createEarrings(headMesh: THREE.Mesh, color: number): void {
    const earringMaterial = classedPartStandardMaterial('gold', {
        color,
        metalness: 0.9
    });
    
    [-0.2, 0.2].forEach(x => {
        const earring = new THREE.Mesh(
            getSharedBoxGeometry(0.04, 0.06, 0.02),
            earringMaterial
        );
        earring.position.set(x, 0.05, 0.15);
        headMesh.add(earring);
    });
}

/**
 * Create a bandage on leg
 */
function createBandage(legMesh: THREE.Mesh, color: number): void {
    const bandageMaterial = new THREE.MeshStandardMaterial({ color: 0xFFFFFF });
    
    const bandage = new THREE.Mesh(
        getSharedBoxGeometry(0.2, 0.08, 0.2),
        bandageMaterial
    );
    bandage.position.set(0, 0, 0.01);
    legMesh.add(bandage);
}

