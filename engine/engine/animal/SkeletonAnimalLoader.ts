/**
 * Skeleton Animal Loader
 * 
 * Loads GLB skeleton files and creates procedural block graphics that follow bone transforms.
 * Uses animations from the GLB file for realistic movement.
 * 
 * Architecture (same as humanoid BlockCharacterRenderer):
 * 1. Load GLB skeleton with animations
 * 2. Create block meshes in a separate group
 * 3. Every frame, read bone world positions and update block positions to match
 * 4. AnimationMixer drives the skeleton, blocks follow
 */

import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { animationAssets } from 'engine/AnimationAssets.js';
import { createClassedPartMaterial } from 'engine/ClassedPartMaterial.js';

/**
 * Configuration for an animal's block appearance attached to skeleton
 */
export interface SkeletonAnimalConfig {
    name: string;
    glbUrl: string;
    animations: string[];
    
    // Block appearance
    bodyColor: number;
    headColor?: number;
    legColor?: number;
    tailColor?: number;
    accentColor?: number;
    
    // Size multipliers
    scale?: number;
    bodyScale?: { x: number; y: number; z: number };
    headScale?: { x: number; y: number; z: number };
    legScale?: { x: number; y: number; z: number };
    
    // Bone name mappings (animal skeleton -> standard names)
    boneMapping?: {
        root?: string;
        spine?: string[];
        head?: string;
        tail?: string[];
        frontLeftLeg?: string[];
        frontRightLeg?: string[];
        backLeftLeg?: string[];
        backRightLeg?: string[];
    };
}

/**
 * Calculate the length of a bone by measuring distance to its first child bone
 */
function getBoneLength(bone: THREE.Bone): number {
    // If bone has children that are also bones, measure to first child
    for (const child of bone.children) {
        if (child instanceof THREE.Bone) {
            const childPos = new THREE.Vector3();
            const bonePos = new THREE.Vector3();
            child.getWorldPosition(childPos);
            bone.getWorldPosition(bonePos);
            const length = bonePos.distanceTo(childPos);
            if (length > 0.01) return length;
        }
    }
    return 0; // No child bone found
}

/**
 * Calculate the overall skeleton size by measuring the bounding box of all bones
 * Returns { size: largest bounding-box dimension, avgBoneLength: average bone length }
 */
function calculateSkeletonMetrics(bones: Map<string, THREE.Bone>): {
    size: number;
    avgBoneLength: number;
} {
    const box = new THREE.Box3();
    const pos = new THREE.Vector3();
    let totalBoneLength = 0;
    let boneCount = 0;

    for (const bone of bones.values()) {
        box.expandByPoint(bone.getWorldPosition(pos));

        const length = getBoneLength(bone);
        if (length > 0.01) {
            totalBoneLength += length;
            boneCount++;
        }
    }

    if (box.isEmpty()) {
        return { size: 1, avgBoneLength: 0.1 };
    }

    const extent = box.getSize(new THREE.Vector3());
    const size = Math.max(extent.x, extent.y, extent.z);

    return { size, avgBoneLength: boneCount > 0 ? totalBoneLength / boneCount : size * 0.1 };
}

/**
 * Look an animal type up in one of the name-keyed tables: exact match on the
 * normalized name first, then a substring match in either direction ('reddragon'
 * finds 'dragon', 'dog' finds 'bulldog'). Shared by the skeleton map and the
 * appearance presets so the two never drift apart.
 */
function matchByAnimalName<T>(table: Record<string, T>, animalType: string): T | undefined {
    const normalized = animalType.toLowerCase().replace(/[\s\-_]/g, '');

    const exact = table[normalized];
    if (exact !== undefined) return exact;

    for (const [key, value] of Object.entries(table)) {
        if (normalized.includes(key) || key.includes(normalized)) {
            return value;
        }
    }
    return undefined;
}

/**
 * Available skeleton bases from the exported GLB files
 * These are the ONLY 7 skeletons available - all animals must map to one of these!
 * 
 * From new-explorer.json animals array:
 * - Chicken (2-legged bird)
 * - Deer (4-legged)
 * - Dog (4-legged)
 * - Horse (4-legged)
 * - Kitty (4-legged small)
 * - Pinguin (2-legged bird)
 * - Tiger (4-legged large)
 */
export type SkeletonBase = 'chicken' | 'deer' | 'dog' | 'horse' | 'kitty' | 'pinguin' | 'tiger';

/**
 * ════════════════════════════════════════════════════════════════════════════════
 * SKELETON SELECTION RULES (Based on available GLBs from new-explorer.json)
 * ════════════════════════════════════════════════════════════════════════════════
 * 
 * AVAILABLE SKELETONS:
 * 🐔 chicken - For birds (2-legged, flying type)
 * 🐧 pinguin - For flightless/wadding birds (2-legged)
 * 🐱 kitty   - For small 4-legged animals + small primates
 * 🐕 dog     - For medium 4-legged animals (canines, pigs, sheep)
 * 🦌 deer    - For deer-like animals (antlers, slim legs)
 * 🐎 horse   - For large hoofed animals (equines, cattle)
 * 🐅 tiger   - For large predators + fantasy beasts (dragons!)
 * 
 * ════════════════════════════════════════════════════════════════════════════════
 */
const ANIMAL_TO_SKELETON_MAP: Record<string, SkeletonBase> = {
    // ═══════════════════════════════════════════════════════════════
    // EXACT MATCHES - Use the skeleton directly by name
    // ═══════════════════════════════════════════════════════════════
    chicken: 'chicken',
    deer: 'deer',
    dog: 'dog',
    horse: 'horse',
    kitty: 'kitty',
    cat: 'kitty',
    pinguin: 'pinguin',
    penguin: 'pinguin',
    tiger: 'tiger',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐔 BIRDS (2-legged!) → Chicken skeleton (flying birds)
    // ═══════════════════════════════════════════════════════════════
    rooster: 'chicken',
    hen: 'chicken',
    duck: 'chicken',
    goose: 'chicken',
    turkey: 'chicken',
    peacock: 'chicken',
    pheasant: 'chicken',
    eagle: 'chicken',
    hawk: 'chicken',
    falcon: 'chicken',
    owl: 'chicken',
    vulture: 'chicken',
    raven: 'chicken',
    crow: 'chicken',
    parrot: 'chicken',
    macaw: 'chicken',
    toucan: 'chicken',
    pelican: 'chicken',
    flamingo: 'chicken',
    swan: 'chicken',
    seagull: 'chicken',
    hummingbird: 'chicken',
    sparrow: 'chicken',
    robin: 'chicken',
    pigeon: 'chicken',
    dove: 'chicken',
    bird: 'chicken',
    
    // 🐧 Flightless/waddling birds → Pinguin skeleton
    ostrich: 'pinguin',
    emu: 'pinguin',
    kiwi: 'pinguin',
    
    // Fantasy birds → Chicken
    phoenix: 'chicken',
    thunderbird: 'chicken',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐒 PRIMATES (use kitty for small, tiger for large)
    // ═══════════════════════════════════════════════════════════════
    monkey: 'kitty',
    ape: 'tiger',
    gorilla: 'tiger',
    chimpanzee: 'kitty',
    orangutan: 'tiger',
    baboon: 'dog',
    gibbon: 'kitty',
    lemur: 'kitty',
    marmoset: 'kitty',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐕 CANINES → Dog skeleton
    // ═══════════════════════════════════════════════════════════════
    wolf: 'dog',
    fox: 'dog',
    coyote: 'dog',
    puppy: 'dog',
    husky: 'dog',
    labrador: 'dog',
    poodle: 'dog',
    bulldog: 'dog',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐱 SMALL FELINES → Kitty skeleton
    // ═══════════════════════════════════════════════════════════════
    kitten: 'kitty',
    housecat: 'kitty',
    
    // 🐅 LARGE FELINES → Tiger skeleton
    lion: 'tiger',
    leopard: 'tiger',
    panther: 'tiger',
    cheetah: 'tiger',
    jaguar: 'tiger',
    cougar: 'tiger',
    puma: 'tiger',
    
    // ═══════════════════════════════════════════════════════════════
    // 🦌 DEER-LIKE → Deer skeleton (slim legs, antlers)
    // ═══════════════════════════════════════════════════════════════
    buck: 'deer',
    doe: 'deer',
    fawn: 'deer',
    elk: 'deer',
    moose: 'deer',
    reindeer: 'deer',
    caribou: 'deer',
    antelope: 'deer',
    gazelle: 'deer',
    goat: 'deer',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐎 EQUINES & LARGE HOOFED → Horse skeleton
    // ═══════════════════════════════════════════════════════════════
    pony: 'horse',
    zebra: 'horse',
    donkey: 'horse',
    mule: 'horse',
    cow: 'horse',
    bull: 'horse',
    ox: 'horse',
    buffalo: 'horse',
    bison: 'horse',
    yak: 'horse',
    camel: 'horse',
    llama: 'horse',
    alpaca: 'horse',
    
    // Mythical equines
    unicorn: 'horse',
    pegasus: 'horse',
    nightmare: 'horse',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐅 LARGE PREDATORS & BEARS → Tiger skeleton
    // ═══════════════════════════════════════════════════════════════
    bear: 'tiger',
    polarbear: 'tiger',
    grizzly: 'tiger',
    panda: 'tiger',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐉 DRAGONS & FANTASY BEASTS → Tiger skeleton (large 4-legged)
    // ═══════════════════════════════════════════════════════════════
    dragon: 'tiger',
    reddragon: 'tiger',
    bluedragon: 'tiger',
    greendragon: 'tiger',
    blackdragon: 'tiger',
    golddragon: 'tiger',
    whitedragon: 'tiger',
    firedragon: 'tiger',
    icedragon: 'tiger',
    drake: 'tiger',
    wyvern: 'tiger',
    wyrm: 'tiger',
    
    griffin: 'tiger',
    gryphon: 'tiger',
    chimera: 'tiger',
    manticore: 'tiger',
    sphinx: 'tiger',
    basilisk: 'tiger',
    hydra: 'tiger',
    
    // Fantasy canines → Dog skeleton
    cerberus: 'dog',
    hellhound: 'dog',
    direwolf: 'dog',
    warg: 'dog',
    fenrir: 'dog',
    werewolf: 'dog',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐱 SMALL MAMMALS → Kitty skeleton
    // ═══════════════════════════════════════════════════════════════
    rabbit: 'kitty',
    bunny: 'kitty',
    hare: 'kitty',
    squirrel: 'kitty',
    chipmunk: 'kitty',
    hamster: 'kitty',
    rat: 'kitty',
    mouse: 'kitty',
    ferret: 'kitty',
    weasel: 'kitty',
    raccoon: 'kitty',
    
    // ═══════════════════════════════════════════════════════════════
    // 🐕 MEDIUM FARM ANIMALS → Dog skeleton
    // ═══════════════════════════════════════════════════════════════
    pig: 'dog',
    hog: 'dog',
    boar: 'dog',
    sheep: 'dog',
    lamb: 'dog',
    ram: 'dog',
};

/**
 * Find the best skeleton base for a given animal type
 */
export function findBestSkeletonBase(animalType: string): SkeletonBase {
    return matchByAnimalName(ANIMAL_TO_SKELETON_MAP, animalType) ?? 'dog';
}

/**
 * Get the GLB URL for a skeleton base
 */
export function getSkeletonGlbUrl(skeleton: SkeletonBase, baseUrl?: string): string {
    const base = baseUrl ?? animationAssets.animalBaseUrl;
    const fileName = animationAssets.animalSkeletons[skeleton];
    return `${base}/${fileName}`;
}

/**
 * Preset configurations for animal appearances
 */
export const SKELETON_ANIMAL_PRESETS: Record<string, Partial<SkeletonAnimalConfig>> = {
    // Base animals
    chicken: { bodyColor: 0xFFFFFF, headColor: 0xFF6B35, legColor: 0xFFD700, scale: 0.5 },
    deer: { bodyColor: 0x8B4513, headColor: 0x654321, legColor: 0x3D2314, scale: 1.2 },
    dog: { bodyColor: 0xD2691E, headColor: 0x8B4513, legColor: 0xA0522D, scale: 0.8 },
    horse: { bodyColor: 0x8B4513, headColor: 0x654321, legColor: 0x3D2314, scale: 1.5 },
    kitty: { bodyColor: 0x808080, headColor: 0x696969, legColor: 0x505050, scale: 0.5 },
    cat: { bodyColor: 0xFF8C00, headColor: 0xCD6600, legColor: 0xA0522D, scale: 0.5 },
    pinguin: { bodyColor: 0x1C1C1C, headColor: 0x1C1C1C, legColor: 0xFF6600, scale: 0.7 },
    tiger: { bodyColor: 0xFF8C00, headColor: 0xFF8C00, legColor: 0xCD6600, scale: 1.3 },
    
    // Canines
    wolf: { bodyColor: 0x696969, headColor: 0x505050, legColor: 0x3D3D3D, scale: 1.0 },
    fox: { bodyColor: 0xFF4500, headColor: 0xFF6347, legColor: 0x1C1C1C, scale: 0.7 },
    
    // Felines
    lion: { bodyColor: 0xDAA520, headColor: 0xB8860B, legColor: 0xCD853F, scale: 1.4 },
    panther: { bodyColor: 0x1C1C1C, headColor: 0x2F2F2F, legColor: 0x0D0D0D, scale: 1.2 },
    
    // Equines
    zebra: { bodyColor: 0xFFFFFF, headColor: 0xFFFFFF, legColor: 0xFFFFFF, scale: 1.4 },
    unicorn: { bodyColor: 0xFFFFFF, headColor: 0xFFF0F5, legColor: 0xF0F0F0, tailColor: 0xFF69B4, scale: 1.5 },
    
    // Bears
    bear: { bodyColor: 0x8B4513, headColor: 0x654321, legColor: 0x3D2314, scale: 1.6 },
    polarbear: { bodyColor: 0xFFFAFA, headColor: 0xF5F5F5, legColor: 0xE8E8E8, scale: 1.7 },
    panda: { bodyColor: 0xFFFFFF, headColor: 0xFFFFFF, legColor: 0x1C1C1C, scale: 1.3 },
    
    // Farm
    cow: { bodyColor: 0xFFFFFF, headColor: 0xFFFFFF, legColor: 0xF5F5F5, scale: 1.6 },
    pig: { bodyColor: 0xFFB6C1, headColor: 0xFFC0CB, legColor: 0xFFB6C1, scale: 0.8 },
    sheep: { bodyColor: 0xFFFAFA, headColor: 0x2F2F2F, legColor: 0x2F2F2F, scale: 0.9 },
    
    // Dragons
    dragon: { bodyColor: 0x228B22, headColor: 0x006400, legColor: 0x2E8B57, tailColor: 0x228B22, scale: 2.0 },
    reddragon: { bodyColor: 0x8B0000, headColor: 0xB22222, legColor: 0x800000, scale: 2.2 },
    bluedragon: { bodyColor: 0x1E90FF, headColor: 0x4169E1, legColor: 0x0000CD, scale: 2.0 },
    blackdragon: { bodyColor: 0x1C1C1C, headColor: 0x2F2F2F, legColor: 0x0D0D0D, scale: 2.3 },
    golddragon: { bodyColor: 0xFFD700, headColor: 0xDAA520, legColor: 0xB8860B, scale: 2.5 },
    firedragon: { bodyColor: 0xFF4500, headColor: 0xFF6347, legColor: 0xDC143C, scale: 2.1 },
    icedragon: { bodyColor: 0x87CEEB, headColor: 0xADD8E6, legColor: 0x4682B4, scale: 2.0 },
    
    // Fantasy
    griffin: { bodyColor: 0xDAA520, headColor: 0xFFD700, legColor: 0x8B4513, scale: 1.5 },
    cerberus: { bodyColor: 0x2F2F2F, headColor: 0x1C1C1C, legColor: 0x0D0D0D, scale: 1.8 },
    hellhound: { bodyColor: 0x1C1C1C, headColor: 0x2F2F2F, legColor: 0x0D0D0D, scale: 1.2 },
    direwolf: { bodyColor: 0x4A4A4A, headColor: 0x3D3D3D, legColor: 0x2F2F2F, scale: 1.4 },
    warg: { bodyColor: 0x3D3D3D, headColor: 0x2F2F2F, legColor: 0x1C1C1C, scale: 1.5 },
    werewolf: { bodyColor: 0x4A4A4A, headColor: 0x3D3D3D, legColor: 0x2F2F2F, scale: 1.3 },
    nightmare: { bodyColor: 0x1C1C1C, headColor: 0x2F2F2F, legColor: 0x0D0D0D, tailColor: 0xFF4500, scale: 1.6 },
    
    // Small
    rabbit: { bodyColor: 0xD3D3D3, headColor: 0xC0C0C0, legColor: 0xA9A9A9, scale: 0.4 },
    squirrel: { bodyColor: 0xD2691E, headColor: 0xCD853F, legColor: 0x8B4513, scale: 0.3 },
    
    // Birds (2-legged!)
    rooster: { bodyColor: 0x8B4513, headColor: 0xFF0000, legColor: 0xFFD700, scale: 0.6 },
    duck: { bodyColor: 0x228B22, headColor: 0x006400, legColor: 0xFF6600, scale: 0.5 },
    goose: { bodyColor: 0xFFFFFF, headColor: 0xF5F5F5, legColor: 0xFF6600, scale: 0.7 },
    turkey: { bodyColor: 0x8B4513, headColor: 0xFF0000, legColor: 0xB22222, scale: 0.8 },
    eagle: { bodyColor: 0x8B4513, headColor: 0xFFFFFF, legColor: 0xFFD700, scale: 0.9 },
    owl: { bodyColor: 0x8B4513, headColor: 0x654321, legColor: 0x8B4513, scale: 0.6 },
    parrot: { bodyColor: 0x00FF00, headColor: 0xFF0000, legColor: 0x4169E1, scale: 0.4 },
    flamingo: { bodyColor: 0xFF69B4, headColor: 0xFFB6C1, legColor: 0xFF69B4, scale: 1.0 },
    swan: { bodyColor: 0xFFFFFF, headColor: 0xFFFFFF, legColor: 0x1C1C1C, scale: 0.9 },
    phoenix: { bodyColor: 0xFF4500, headColor: 0xFFD700, legColor: 0xFF6347, tailColor: 0xFF0000, scale: 1.2 },
    
    // Primates (2-legged!)
    monkey: { bodyColor: 0x8B4513, headColor: 0xD2691E, legColor: 0x654321, scale: 0.6 },
    ape: { bodyColor: 0x2F2F2F, headColor: 0x1C1C1C, legColor: 0x0D0D0D, scale: 1.0 },
    gorilla: { bodyColor: 0x2F2F2F, headColor: 0x1C1C1C, legColor: 0x0D0D0D, scale: 1.5 },
    chimpanzee: { bodyColor: 0x3D3D3D, headColor: 0xFFDBB3, legColor: 0x2F2F2F, scale: 0.8 },
    orangutan: { bodyColor: 0xFF8C00, headColor: 0xCD6600, legColor: 0xA0522D, scale: 1.0 },
    baboon: { bodyColor: 0x8B4513, headColor: 0xFFDBB3, legColor: 0x654321, scale: 0.9 },
    lemur: { bodyColor: 0x696969, headColor: 0xFFFFFF, legColor: 0x1C1C1C, scale: 0.5 },
};

/** Bone-name fragments that mark a bone as a limb (leg, arm, wing or fin). */
const LIMB_BONE_KEYWORDS = [
    'thigh', 'shin', 'calf', 'knee', 'ankle', 'foot', 'toe', 'paw', 'claw',
    'shoulder', 'arm', 'elbow', 'wrist', 'hand', 'finger', 'wing', 'fin',
];

/** How a merged head block is detailed — snout, ears, eyes and the rest. */
type HeadStyle = 'canine' | 'feline' | 'equine' | 'bird' | 'bear' | 'pig' | 'dragon' | 'primate' | 'rodent';

/**
 * Name keywords that pick a head style, in priority order (first row whose
 * keyword appears in the animal name wins). Anything unmatched is 'canine'.
 */
const HEAD_STYLE_KEYWORDS: ReadonlyArray<readonly [HeadStyle, readonly string[]]> = [
    ['feline', ['cat', 'kitty', 'tiger', 'lion', 'leopard', 'panther', 'cheetah', 'jaguar', 'cougar', 'lynx']],
    ['equine', ['horse', 'deer', 'elk', 'moose', 'donkey', 'zebra', 'giraffe', 'camel', 'llama', 'alpaca']],
    ['bird', ['chicken', 'rooster', 'duck', 'goose', 'turkey', 'eagle', 'owl', 'parrot', 'flamingo', 'swan', 'phoenix', 'penguin', 'pinguin']],
    ['bear', ['bear', 'panda', 'polarbear']],
    ['pig', ['pig', 'boar', 'warthog', 'hippo']],
    ['dragon', ['dragon', 'wyvern', 'drake']],
    ['primate', ['monkey', 'ape', 'gorilla', 'chimp', 'orangutan', 'baboon', 'lemur']],
    ['rodent', ['rabbit', 'squirrel', 'hamster', 'mouse', 'rat', 'beaver']],
];

/**
 * The one mesh every part of a skeleton animal is made of: a shadowed box on
 * the 'fur' material class (soft sheen at high quality, Lambert on low).
 */
function furBlock(width: number, height: number, depth: number, color: number): THREE.Mesh {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(width, height, depth),
        createClassedPartMaterial('fur', { color })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
}

/**
 * Block binding - maps a block mesh to a bone for position updates
 */
type BlockBinding =
    | {
          mode: 'bone';
          mesh: THREE.Mesh;
          boneName: string;
          offset: THREE.Vector3;
          followRotation: boolean; // If false, block keeps fixed rotation (for head)
      }
    | {
          mode: 'bounds';
          mesh: THREE.Mesh;
          boneNames: string[];
          padding: THREE.Vector3;
          followRotation: false;
      }
    | {
          // Optimized mode: fixed size, only updates centroid position
          mode: 'centroid';
          mesh: THREE.Mesh;
          boneNames: string[];
          fixedScale: THREE.Vector3; // Pre-calculated size, doesn't change
      };

/**
 * Result of loading a skeleton animal
 */
export interface SkeletonAnimalInstance {
    root: THREE.Group;
    skeleton: THREE.Object3D;
    mixer: THREE.AnimationMixer;
    animations: Map<string, THREE.AnimationClip>;
    currentAction: THREE.AnimationAction | null;
    blockMeshes: THREE.Mesh[];
    playAnimation: (name: string, options?: { loop?: boolean; crossFade?: number }) => void;
    update: (deltaTime: number) => void;
    dispose: () => void;
}

/**
 * Load a skeleton animal from GLB and create block graphics
 */
export async function loadSkeletonAnimal(
    loader: any, // GLTFLoader
    config: SkeletonAnimalConfig
): Promise<SkeletonAnimalInstance> {
    console.log(`🦴 Loading skeleton animal: ${config.name} from ${config.glbUrl}`);
    
    // Load the GLB
    const gltf: GLTF = await new Promise((resolve, reject) => {
        loader.load(
            config.glbUrl,
            (gltf: GLTF) => resolve(gltf),
            undefined,
            (error: Error) => reject(error)
        );
    });
    
    console.log(`  📦 Loaded GLTF with ${gltf.animations.length} animations`);
    
    // Clone the scene properly using SkeletonUtils.clone
    const clonedScene = cloneSkeleton(gltf.scene);
    
    // Create root group
    const root = new THREE.Group();
    root.name = `SkeletonAnimal_${config.name}`;
    
    // Add cloned scene to root
    root.add(clonedScene);
    
    // Apply scale
    const scale = config.scale ?? 1.0;
    root.scale.setScalar(scale);
    
    // Create animation mixer on the cloned scene
    const mixer = new THREE.AnimationMixer(clonedScene);
    
    // Map animations - clone the clips for the cloned scene
    const animations = new Map<string, THREE.AnimationClip>();
    const skeletonBase = findBestSkeletonBase(config.name);
    const animalPrefix = skeletonBase.charAt(0).toUpperCase() + skeletonBase.slice(1) + '_001_';
    
    for (const clip of gltf.animations) {
        let animName = clip.name;
        // Extract animation name from clip name
        // GLB animations are named like "Chicken_001_idle", "Tiger_001_idle_rare", etc.
        // Extract everything after "_001_" prefix
        const lowerName = animName.toLowerCase();
        
        // Try to extract the action name after the "_001_" prefix
        const prefixMatch = lowerName.match(/_001_(.+)$/);
        if (prefixMatch && prefixMatch[1]) {
            animName = prefixMatch[1]; // e.g., "idle", "run", "walk", "idle_rare"
        } else {
            // Fallback: Check for specific patterns (more specific first!)
            if (lowerName.includes('idle_rare')) animName = 'idle_rare';
            else if (lowerName.includes('_idle')) animName = 'idle';
            else if (lowerName.includes('_run')) animName = 'run';
            else if (lowerName.includes('_walk')) animName = 'walk';
            else if (lowerName.includes('_eat')) animName = 'eat';
        }
        
        const finalName = animName.toLowerCase();
        animations.set(finalName, clip);
        console.log(`  📎 Animation: "${clip.name}" → "${finalName}" (${clip.duration.toFixed(2)}s)`);
    }
    
    // Find all bones in the cloned scene
    const bones = new Map<string, THREE.Bone>();
    clonedScene.traverse((obj: THREE.Object3D) => {
        if (obj instanceof THREE.Bone) {
            bones.set(obj.name, obj);
        }
    });
    console.log(`  🦴 Found ${bones.size} bones: ${Array.from(bones.keys()).slice(0, 5).join(', ')}...`);
    
    // Calculate skeleton metrics for proper sizing
    const skeletonMetrics = calculateSkeletonMetrics(bones);
    const skeletonSize = skeletonMetrics.size;
    const avgBoneLength = skeletonMetrics.avgBoneLength;
    
    // Block thickness relative to skeleton - smaller animals get proportionally thicker blocks
    // This creates a nice "blocky" look that scales well
    const blockThickness = Math.max(avgBoneLength * 0.4, skeletonSize * 0.03);
    
    console.log(`  📏 Skeleton size: ${skeletonSize.toFixed(3)}, avg bone: ${avgBoneLength.toFixed(3)}, block thickness: ${blockThickness.toFixed(3)}`);
    
    // Create block meshes group (separate from skeleton)
    const blockGroup = new THREE.Group();
    blockGroup.name = 'BlockCharacter';
    root.add(blockGroup);
    
    // Block bindings for update loop
    const blockBindings: BlockBinding[] = [];
    const blockMeshes: THREE.Mesh[] = [];
    
    // Get colors
    const bodyColor = config.bodyColor;
    const headColor = config.headColor ?? bodyColor;
    const legColor = config.legColor ?? bodyColor;
    const tailColor = config.tailColor ?? bodyColor;
    
    // Helper to create and bind a block
    const createBoundBlock = (
        boneName: string, 
        width: number, height: number, depth: number, 
        color: number,
        offset: THREE.Vector3 = new THREE.Vector3(),
        followRotation: boolean = true  // Set false for head to keep it facing forward
    ): THREE.Mesh | null => {
        const bone = bones.get(boneName);
        if (!bone) return null;

        const mesh = furBlock(width, height, depth, color);
        mesh.name = `Block_${boneName}`;

        blockGroup.add(mesh);
        blockMeshes.push(mesh);
        blockBindings.push({ mode: 'bone', mesh, boneName, offset: offset.clone(), followRotation });
        
        return mesh;
    };

    // Helper to create a centroid-tracking block with FIXED size (calculated once at load).
    // Much faster than bounds mode - only updates position, not size.
    const createCentroidBlock = (
        name: string,
        boneNames: string[],
        color: number,
        padding: THREE.Vector3 = new THREE.Vector3(blockSize * 0.15, blockSize * 0.15, blockSize * 0.15)
    ): THREE.Mesh | null => {
        const filtered = boneNames.filter((b) => bones.has(b));
        if (filtered.length === 0) return null;

        // Calculate size ONCE at load time from current bone positions
        clonedScene.updateMatrixWorld(true);
        root.updateMatrixWorld(true);
        const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
        
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        const tmpPos = new THREE.Vector3();
        
        for (const boneName of filtered) {
            const bone = bones.get(boneName);
            if (!bone) continue;
            bone.getWorldPosition(tmpPos);
            tmpPos.applyMatrix4(invRoot);
            minX = Math.min(minX, tmpPos.x);
            minY = Math.min(minY, tmpPos.y);
            minZ = Math.min(minZ, tmpPos.z);
            maxX = Math.max(maxX, tmpPos.x);
            maxY = Math.max(maxY, tmpPos.y);
            maxZ = Math.max(maxZ, tmpPos.z);
        }
        
        // Fixed size with padding
        const fixedScale = new THREE.Vector3(
            Math.max(maxX - minX + padding.x * 2, 0.01),
            Math.max(maxY - minY + padding.y * 2, 0.01),
            Math.max(maxZ - minZ + padding.z * 2, 0.01)
        );

        // Unit cube with fixed scale
        const mesh = furBlock(1, 1, 1, color);
        mesh.name = `Block_${name}`;
        mesh.scale.copy(fixedScale);

        blockGroup.add(mesh);
        blockMeshes.push(mesh);
        blockBindings.push({ mode: 'centroid', mesh, boneNames: filtered, fixedScale: fixedScale.clone() });

        return mesh;
    };
    
    // Helper to add detail block to a parent mesh
    const addDetailBlock = (
        parent: THREE.Mesh,
        width: number, height: number, depth: number,
        color: number,
        position: THREE.Vector3
    ): THREE.Mesh => {
        const mesh = furBlock(width, height, depth, color);
        mesh.position.copy(position);
        parent.add(mesh);
        return mesh;
    };

    // Block size proportional to skeleton
    const blockSize = Math.max(skeletonSize * 0.08, avgBoneLength * 0.5);
    
    console.log(`  📐 Skeleton: size=${skeletonSize.toFixed(3)}, avgBone=${avgBoneLength.toFixed(3)}, blockSize=${blockSize.toFixed(3)}`);
    console.log(`  🦴 ALL BONES (${bones.size}): ${Array.from(bones.keys()).join(', ')}`);
    
    // ════════════════════════════════════════════════════════════════
    // STEP 1: IDENTIFY HEAD/NECK BONES AND CREATE MERGED HEAD BLOCK
    // ════════════════════════════════════════════════════════════════
    
    // Find the highest spine number for neck detection
    let maxSpineNum = 0;
    for (const boneName of bones.keys()) {
        const match = boneName.match(/spine\.(\d+)/);
        if (match && match[1]) {
            maxSpineNum = Math.max(maxSpineNum, parseInt(match[1]));
        }
    }
    
    // Collect all head/neck bones
    const headNeckBones: string[] = [];
    let primaryHeadBone: string | null = null;
    let jawBone: string | null = null;
    let highestSpineBone: string | null = null;
    
    for (const boneName of bones.keys()) {
        const lower = boneName.toLowerCase();
        
        // Primary head bone candidates (in priority order): scull > skull > head
        if (lower === 'scull' || lower === 'skull' || lower === 'head') {
            primaryHeadBone = boneName;
            headNeckBones.push(boneName);
        }
        // Jaw is fallback for tiger skeleton (which has no scull)
        else if (lower === 'jaw') {
            jawBone = boneName;
            headNeckBones.push(boneName);
        }
        // Other head parts (ears, etc.)
        else if (lower.includes('ear') || lower.includes('cranium')) {
            headNeckBones.push(boneName);
        }
        // High spine numbers are neck bones (top 25% of spine)
        else if (lower.startsWith('spine.')) {
            const match = boneName.match(/spine\.(\d+)/);
            if (match && match[1]) {
                const num = parseInt(match[1]);
                if (num >= maxSpineNum * 0.75) {
                    headNeckBones.push(boneName);
                    // Track highest spine as final fallback
                    if (num === maxSpineNum) {
                        highestSpineBone = boneName;
                    }
                }
            }
        }
    }
    
    // Priority for primary head bone: scull/skull/head > jaw > highest spine
    let usingJawAsHead = false;
    if (!primaryHeadBone && jawBone) {
        primaryHeadBone = jawBone;
        usingJawAsHead = true;
        console.log(`  🐯 Using JAW as primary head bone (tiger skeleton)`);
    }
    if (!primaryHeadBone && highestSpineBone) {
        primaryHeadBone = highestSpineBone;
        console.log(`  ⚠️ Using highest spine as fallback head bone`);
    }
    
    console.log(`  🐺 HEAD/NECK bones (${headNeckBones.length}): ${headNeckBones.join(', ')}`);
    console.log(`  🐺 Primary head bone: ${primaryHeadBone}`);
    
    // Create the merged head block
    const headBonesSet = new Set(headNeckBones);

    if (primaryHeadBone && bones.has(primaryHeadBone)) {
        // Calculate head size based on all head/neck bones
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;
        
        for (const boneName of headNeckBones) {
            const bone = bones.get(boneName);
            if (bone) {
                const pos = new THREE.Vector3();
                bone.getWorldPosition(pos);
                minY = Math.min(minY, pos.y);
                maxY = Math.max(maxY, pos.y);
                minZ = Math.min(minZ, pos.z);
                maxZ = Math.max(maxZ, pos.z);
            }
        }
        
        // Head size encompasses all head/neck bones
        const headHeight = Math.max(maxY - minY, blockSize * 1.5, avgBoneLength * 1.2);
        const headWidth = headHeight * 0.85;
        const headDepth = Math.max(maxZ - minZ, blockSize * 1.2, avgBoneLength * 1.0);
        
        // If using jaw as head bone, offset the head upward by half its height
        // This compensates for jaw being lower than the actual head center
        const headOffset = usingJawAsHead 
            ? new THREE.Vector3(0, headHeight * 0.5, 0)  // Offset up
            : new THREE.Vector3();
        
        console.log(`  🐺 Creating merged head: ${headWidth.toFixed(3)} x ${headHeight.toFixed(3)} x ${headDepth.toFixed(3)}${usingJawAsHead ? ' (offset up for jaw)' : ''}`);
        
        // Head uses followRotation=false to keep facing forward regardless of bone rotation
        const headMesh = createBoundBlock(primaryHeadBone, headWidth, headHeight, headDepth, headColor, headOffset, false);
        
        if (headMesh) {
            // Determine head style based on animal name — first matching row
            // wins, so the table order IS the priority. Default 'canine' covers
            // dog, wolf, fox, coyote, hyena, etc.
            const animalLower = config.name.toLowerCase();
            const headStyle = HEAD_STYLE_KEYWORDS.find(
                ([, keywords]) => keywords.some(k => animalLower.includes(k))
            )?.[0] ?? 'canine';

            console.log(`  🐺 Head style: ${headStyle} for ${config.name}`);
            
            // ════════════════════════════════════════════════════════════════
            // WILDLY DIFFERENT HEAD STYLES
            // ════════════════════════════════════════════════════════════════
            
            switch (headStyle) {
                // ═══════════════════════════════════════════════════════════
                // CANINE: Long pointed snout, upright triangular ears
                // ═══════════════════════════════════════════════════════════
                case 'canine': {
                    // Long pointed snout
                    const snoutW = headWidth * 0.38;
                    const snoutH = headHeight * 0.32;
                    const snoutD = headDepth * 0.7;
                    const snout = addDetailBlock(headMesh, snoutW, snoutH, snoutD, headColor,
                        new THREE.Vector3(0, -headHeight * 0.05, headDepth * 0.55));
                    
                    // Black nose
                    addDetailBlock(snout, snoutW * 0.6, snoutH * 0.4, snoutD * 0.15, 0x1C1C1C,
                        new THREE.Vector3(0, snoutH * 0.2, snoutD * 0.45));
                    
                    // Pointed triangular ears - tall and narrow
                    const earW = headWidth * 0.15;
                    const earH = headHeight * 0.5;
                    addDetailBlock(headMesh, earW, earH, headDepth * 0.1, headColor,
                        new THREE.Vector3(-headWidth * 0.3, headHeight * 0.5, -headDepth * 0.1));
                    addDetailBlock(headMesh, earW, earH, headDepth * 0.1, headColor,
                        new THREE.Vector3(headWidth * 0.3, headHeight * 0.5, -headDepth * 0.1));
                    
                    // Eyes on sides
                    const eyeS = headHeight * 0.12;
                    const leftEye = addDetailBlock(headMesh, eyeS, eyeS * 0.7, eyeS * 0.5, 0x8B4513,
                        new THREE.Vector3(-headWidth * 0.25, headHeight * 0.1, headDepth * 0.35));
                    addDetailBlock(leftEye, eyeS * 0.4, eyeS * 0.4, eyeS * 0.3, 0x000000,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    const rightEye = addDetailBlock(headMesh, eyeS, eyeS * 0.7, eyeS * 0.5, 0x8B4513,
                        new THREE.Vector3(headWidth * 0.25, headHeight * 0.1, headDepth * 0.35));
                    addDetailBlock(rightEye, eyeS * 0.4, eyeS * 0.4, eyeS * 0.3, 0x000000,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    
                    // Visible fangs
                    addDetailBlock(headMesh, snoutW * 0.1, headHeight * 0.12, snoutW * 0.08, 0xFFFFF0,
                        new THREE.Vector3(-snoutW * 0.25, -headHeight * 0.2, headDepth * 0.6));
                    addDetailBlock(headMesh, snoutW * 0.1, headHeight * 0.12, snoutW * 0.08, 0xFFFFF0,
                        new THREE.Vector3(snoutW * 0.25, -headHeight * 0.2, headDepth * 0.6));
                    break;
                }
                
                // ═══════════════════════════════════════════════════════════
                // FELINE: Round face, small snout, big eyes, pointed ears
                // ═══════════════════════════════════════════════════════════
                case 'feline': {
                    // Small round snout/muzzle
                    const snoutW = headWidth * 0.5;
                    const snoutH = headHeight * 0.25;
                    const snoutD = headDepth * 0.3;
                    const snout = addDetailBlock(headMesh, snoutW, snoutH, snoutD, headColor,
                        new THREE.Vector3(0, -headHeight * 0.15, headDepth * 0.45));
                    
                    // Pink triangle nose
                    addDetailBlock(snout, snoutW * 0.35, snoutH * 0.5, snoutD * 0.3, 0xFFB6C1,
                        new THREE.Vector3(0, snoutH * 0.3, snoutD * 0.35));
                    
                    // Pointed ears - wide at base, more on top of head
                    const earW = headWidth * 0.25;
                    const earH = headHeight * 0.4;
                    addDetailBlock(headMesh, earW, earH, headDepth * 0.12, headColor,
                        new THREE.Vector3(-headWidth * 0.32, headHeight * 0.45, 0));
                    addDetailBlock(headMesh, earW, earH, headDepth * 0.12, headColor,
                        new THREE.Vector3(headWidth * 0.32, headHeight * 0.45, 0));
                    // Pink inner ears
                    addDetailBlock(headMesh, earW * 0.5, earH * 0.6, headDepth * 0.06, 0xFFB6C1,
                        new THREE.Vector3(-headWidth * 0.32, headHeight * 0.48, headDepth * 0.04));
                    addDetailBlock(headMesh, earW * 0.5, earH * 0.6, headDepth * 0.06, 0xFFB6C1,
                        new THREE.Vector3(headWidth * 0.32, headHeight * 0.48, headDepth * 0.04));
                    
                    // BIG round eyes - very prominent
                    const eyeS = headHeight * 0.22;
                    const leftEye = addDetailBlock(headMesh, eyeS, eyeS * 0.8, eyeS * 0.5, 0xFFD700,
                        new THREE.Vector3(-headWidth * 0.22, headHeight * 0.1, headDepth * 0.4));
                    // Slit pupil
                    addDetailBlock(leftEye, eyeS * 0.15, eyeS * 0.7, eyeS * 0.3, 0x000000,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    const rightEye = addDetailBlock(headMesh, eyeS, eyeS * 0.8, eyeS * 0.5, 0xFFD700,
                        new THREE.Vector3(headWidth * 0.22, headHeight * 0.1, headDepth * 0.4));
                    addDetailBlock(rightEye, eyeS * 0.15, eyeS * 0.7, eyeS * 0.3, 0x000000,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    
                    // Whisker dots
                    const dotS = headWidth * 0.04;
                    for (let i = 0; i < 3; i++) {
                        addDetailBlock(headMesh, dotS, dotS, dotS, 0x2F2F2F,
                            new THREE.Vector3(-headWidth * 0.3, -headHeight * 0.05 - i * dotS * 1.5, headDepth * 0.45));
                        addDetailBlock(headMesh, dotS, dotS, dotS, 0x2F2F2F,
                            new THREE.Vector3(headWidth * 0.3, -headHeight * 0.05 - i * dotS * 1.5, headDepth * 0.45));
                    }
                    break;
                }
                
                // ═══════════════════════════════════════════════════════════
                // EQUINE: Very long face, nostrils, tall thin ears on top
                // ═══════════════════════════════════════════════════════════
                case 'equine': {
                    // VERY long snout/face
                    const snoutW = headWidth * 0.45;
                    const snoutH = headHeight * 0.5;
                    const snoutD = headDepth * 1.1;
                    const snout = addDetailBlock(headMesh, snoutW, snoutH, snoutD, headColor,
                        new THREE.Vector3(0, -headHeight * 0.2, headDepth * 0.7));
                    
                    // Large nostrils
                    addDetailBlock(snout, snoutW * 0.2, snoutH * 0.15, snoutD * 0.08, 0x2F2F2F,
                        new THREE.Vector3(-snoutW * 0.25, snoutH * 0.15, snoutD * 0.48));
                    addDetailBlock(snout, snoutW * 0.2, snoutH * 0.15, snoutD * 0.08, 0x2F2F2F,
                        new THREE.Vector3(snoutW * 0.25, snoutH * 0.15, snoutD * 0.48));
                    
                    // Tall thin ears - pointing up and slightly forward
                    const earW = headWidth * 0.1;
                    const earH = headHeight * 0.55;
                    addDetailBlock(headMesh, earW, earH, headDepth * 0.08, headColor,
                        new THREE.Vector3(-headWidth * 0.25, headHeight * 0.55, headDepth * 0.1));
                    addDetailBlock(headMesh, earW, earH, headDepth * 0.08, headColor,
                        new THREE.Vector3(headWidth * 0.25, headHeight * 0.55, headDepth * 0.1));
                    
                    // Eyes on sides of head (prey animal)
                    const eyeS = headHeight * 0.12;
                    const leftEye = addDetailBlock(headMesh, eyeS, eyeS * 0.7, eyeS * 0.5, 0x2F1810,
                        new THREE.Vector3(-headWidth * 0.4, headHeight * 0.15, headDepth * 0.2));
                    addDetailBlock(leftEye, eyeS * 0.5, eyeS * 0.5, eyeS * 0.3, 0x000000,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    const rightEye = addDetailBlock(headMesh, eyeS, eyeS * 0.7, eyeS * 0.5, 0x2F1810,
                        new THREE.Vector3(headWidth * 0.4, headHeight * 0.15, headDepth * 0.2));
                    addDetailBlock(rightEye, eyeS * 0.5, eyeS * 0.5, eyeS * 0.3, 0x000000,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    break;
                }
                
                // ═══════════════════════════════════════════════════════════
                // BIRD: Beak, round head, no ears, side eyes
                // ═══════════════════════════════════════════════════════════
                case 'bird': {
                    // Beak - pointed
                    const beakW = headWidth * 0.2;
                    const beakH = headHeight * 0.15;
                    const beakD = headDepth * 0.6;
                    addDetailBlock(headMesh, beakW, beakH, beakD, 0xFFA500,
                        new THREE.Vector3(0, 0, headDepth * 0.55));
                    // Lower beak
                    addDetailBlock(headMesh, beakW * 0.8, beakH * 0.6, beakD * 0.5, 0xFFA500,
                        new THREE.Vector3(0, -headHeight * 0.12, headDepth * 0.5));
                    
                    // Round eyes on sides
                    const eyeS = headHeight * 0.2;
                    addDetailBlock(headMesh, eyeS * 0.5, eyeS, eyeS * 0.5, 0x000000,
                        new THREE.Vector3(-headWidth * 0.35, headHeight * 0.05, headDepth * 0.25));
                    addDetailBlock(headMesh, eyeS * 0.5, eyeS, eyeS * 0.5, 0x000000,
                        new THREE.Vector3(headWidth * 0.35, headHeight * 0.05, headDepth * 0.25));
                    
                    // Small crest on top for some birds
                    addDetailBlock(headMesh, headWidth * 0.15, headHeight * 0.25, headDepth * 0.2, headColor,
                        new THREE.Vector3(0, headHeight * 0.45, -headDepth * 0.1));
                    break;
                }
                
                // ═══════════════════════════════════════════════════════════
                // BEAR: Round head, small round ears, short snout
                // ═══════════════════════════════════════════════════════════
                case 'bear': {
                    // Short wide snout
                    const snoutW = headWidth * 0.55;
                    const snoutH = headHeight * 0.35;
                    const snoutD = headDepth * 0.4;
                    const snout = addDetailBlock(headMesh, snoutW, snoutH, snoutD, headColor,
                        new THREE.Vector3(0, -headHeight * 0.1, headDepth * 0.45));
                    
                    // Big black nose
                    addDetailBlock(snout, snoutW * 0.45, snoutH * 0.4, snoutD * 0.25, 0x1C1C1C,
                        new THREE.Vector3(0, snoutH * 0.2, snoutD * 0.4));
                    
                    // Small round ears on top/sides
                    const earS = headHeight * 0.22;
                    addDetailBlock(headMesh, earS, earS, earS * 0.5, headColor,
                        new THREE.Vector3(-headWidth * 0.38, headHeight * 0.35, -headDepth * 0.1));
                    addDetailBlock(headMesh, earS, earS, earS * 0.5, headColor,
                        new THREE.Vector3(headWidth * 0.38, headHeight * 0.35, -headDepth * 0.1));
                    
                    // Small beady eyes
                    const eyeS = headHeight * 0.1;
                    addDetailBlock(headMesh, eyeS, eyeS * 0.8, eyeS * 0.5, 0x000000,
                        new THREE.Vector3(-headWidth * 0.2, headHeight * 0.1, headDepth * 0.4));
                    addDetailBlock(headMesh, eyeS, eyeS * 0.8, eyeS * 0.5, 0x000000,
                        new THREE.Vector3(headWidth * 0.2, headHeight * 0.1, headDepth * 0.4));
                    break;
                }
                
                // ═══════════════════════════════════════════════════════════
                // PIG: Flat snout with nostrils, floppy ears
                // ═══════════════════════════════════════════════════════════
                case 'pig': {
                    // Flat disk snout
                    const snoutW = headWidth * 0.5;
                    const snoutH = headHeight * 0.35;
                    const snoutD = headDepth * 0.25;
                    const snout = addDetailBlock(headMesh, snoutW, snoutH, snoutD, 0xFFB6C1,
                        new THREE.Vector3(0, -headHeight * 0.05, headDepth * 0.5));
                    
                    // Two nostril holes
                    addDetailBlock(snout, snoutW * 0.15, snoutH * 0.2, snoutD * 0.3, 0x8B4513,
                        new THREE.Vector3(-snoutW * 0.2, 0, snoutD * 0.35));
                    addDetailBlock(snout, snoutW * 0.15, snoutH * 0.2, snoutD * 0.3, 0x8B4513,
                        new THREE.Vector3(snoutW * 0.2, 0, snoutD * 0.35));
                    
                    // Floppy ears pointing DOWN and out
                    const earW = headWidth * 0.35;
                    const earH = headHeight * 0.35;
                    addDetailBlock(headMesh, earW, earH, headDepth * 0.08, headColor,
                        new THREE.Vector3(-headWidth * 0.35, headHeight * 0.15, -headDepth * 0.15));
                    addDetailBlock(headMesh, earW, earH, headDepth * 0.08, headColor,
                        new THREE.Vector3(headWidth * 0.35, headHeight * 0.15, -headDepth * 0.15));
                    
                    // Small eyes
                    const eyeS = headHeight * 0.1;
                    addDetailBlock(headMesh, eyeS, eyeS * 0.7, eyeS * 0.5, 0x000000,
                        new THREE.Vector3(-headWidth * 0.22, headHeight * 0.1, headDepth * 0.38));
                    addDetailBlock(headMesh, eyeS, eyeS * 0.7, eyeS * 0.5, 0x000000,
                        new THREE.Vector3(headWidth * 0.22, headHeight * 0.1, headDepth * 0.38));
                    break;
                }
                
                // ═══════════════════════════════════════════════════════════
                // DRAGON: Long snout, horns, spikes, fierce eyes
                // ═══════════════════════════════════════════════════════════
                case 'dragon': {
                    // Long angular snout
                    const snoutW = headWidth * 0.4;
                    const snoutH = headHeight * 0.35;
                    const snoutD = headDepth * 0.8;
                    const snout = addDetailBlock(headMesh, snoutW, snoutH, snoutD, headColor,
                        new THREE.Vector3(0, -headHeight * 0.05, headDepth * 0.6));
                    
                    // Nostrils with smoke effect
                    addDetailBlock(snout, snoutW * 0.15, snoutH * 0.15, snoutD * 0.1, 0x2F2F2F,
                        new THREE.Vector3(-snoutW * 0.3, snoutH * 0.25, snoutD * 0.45));
                    addDetailBlock(snout, snoutW * 0.15, snoutH * 0.15, snoutD * 0.1, 0x2F2F2F,
                        new THREE.Vector3(snoutW * 0.3, snoutH * 0.25, snoutD * 0.45));
                    
                    // HORNS - large and curved back
                    const hornColor = 0x3D3D3D;
                    addDetailBlock(headMesh, headWidth * 0.1, headHeight * 0.6, headDepth * 0.25, hornColor,
                        new THREE.Vector3(-headWidth * 0.3, headHeight * 0.55, -headDepth * 0.25));
                    addDetailBlock(headMesh, headWidth * 0.1, headHeight * 0.6, headDepth * 0.25, hornColor,
                        new THREE.Vector3(headWidth * 0.3, headHeight * 0.55, -headDepth * 0.25));
                    
                    // Spikes along back of head
                    for (let i = 0; i < 3; i++) {
                        const spikeH = headHeight * (0.25 - i * 0.05);
                        addDetailBlock(headMesh, headWidth * 0.08, spikeH, headDepth * 0.1, hornColor,
                            new THREE.Vector3(0, headHeight * 0.35 - i * headHeight * 0.15, -headDepth * 0.35 - i * headDepth * 0.1));
                    }
                    
                    // Fierce slanted eyes
                    const eyeS = headHeight * 0.16;
                    const leftEye = addDetailBlock(headMesh, eyeS, eyeS * 0.5, eyeS * 0.5, 0xFF4500,
                        new THREE.Vector3(-headWidth * 0.25, headHeight * 0.15, headDepth * 0.35));
                    addDetailBlock(leftEye, eyeS * 0.3, eyeS * 0.4, eyeS * 0.3, 0x000000,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    const rightEye = addDetailBlock(headMesh, eyeS, eyeS * 0.5, eyeS * 0.5, 0xFF4500,
                        new THREE.Vector3(headWidth * 0.25, headHeight * 0.15, headDepth * 0.35));
                    addDetailBlock(rightEye, eyeS * 0.3, eyeS * 0.4, eyeS * 0.3, 0x000000,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    
                    // Visible fangs
                    addDetailBlock(headMesh, snoutW * 0.1, headHeight * 0.15, snoutW * 0.08, 0xFFFFF0,
                        new THREE.Vector3(-snoutW * 0.3, -headHeight * 0.22, headDepth * 0.7));
                    addDetailBlock(headMesh, snoutW * 0.1, headHeight * 0.15, snoutW * 0.08, 0xFFFFF0,
                        new THREE.Vector3(snoutW * 0.3, -headHeight * 0.22, headDepth * 0.7));
                    break;
                }
                
                // ═══════════════════════════════════════════════════════════
                // PRIMATE: Flat face, prominent brow, round ears on sides
                // ═══════════════════════════════════════════════════════════
                case 'primate': {
                    // Very short flat snout/nose area
                    const snoutW = headWidth * 0.4;
                    const snoutH = headHeight * 0.2;
                    const snoutD = headDepth * 0.2;
                    addDetailBlock(headMesh, snoutW, snoutH, snoutD, headColor,
                        new THREE.Vector3(0, -headHeight * 0.1, headDepth * 0.45));
                    
                    // Flat wide nose
                    addDetailBlock(headMesh, headWidth * 0.25, headHeight * 0.1, headDepth * 0.1, 0x3D2314,
                        new THREE.Vector3(0, -headHeight * 0.05, headDepth * 0.5));
                    
                    // Round ears on SIDES of head
                    const earS = headHeight * 0.25;
                    addDetailBlock(headMesh, earS * 0.4, earS, earS * 0.5, headColor,
                        new THREE.Vector3(-headWidth * 0.48, headHeight * 0.05, 0));
                    addDetailBlock(headMesh, earS * 0.4, earS, earS * 0.5, headColor,
                        new THREE.Vector3(headWidth * 0.48, headHeight * 0.05, 0));
                    
                    // Prominent brow ridge
                    addDetailBlock(headMesh, headWidth * 0.7, headHeight * 0.12, headDepth * 0.15, headColor,
                        new THREE.Vector3(0, headHeight * 0.25, headDepth * 0.35));
                    
                    // Forward-facing eyes (predator)
                    const eyeS = headHeight * 0.15;
                    const leftEye = addDetailBlock(headMesh, eyeS, eyeS * 0.7, eyeS * 0.5, 0xFFFFFF,
                        new THREE.Vector3(-headWidth * 0.18, headHeight * 0.1, headDepth * 0.42));
                    addDetailBlock(leftEye, eyeS * 0.5, eyeS * 0.5, eyeS * 0.3, 0x3D2314,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    const rightEye = addDetailBlock(headMesh, eyeS, eyeS * 0.7, eyeS * 0.5, 0xFFFFFF,
                        new THREE.Vector3(headWidth * 0.18, headHeight * 0.1, headDepth * 0.42));
                    addDetailBlock(rightEye, eyeS * 0.5, eyeS * 0.5, eyeS * 0.3, 0x3D2314,
                        new THREE.Vector3(0, 0, eyeS * 0.15));
                    break;
                }
                
                // ═══════════════════════════════════════════════════════════
                // RODENT: Small pointed snout, HUGE round ears, big eyes
                // ═══════════════════════════════════════════════════════════
                case 'rodent': {
                    // Small pointed snout
                    const snoutW = headWidth * 0.3;
                    const snoutH = headHeight * 0.25;
                    const snoutD = headDepth * 0.4;
                    const snout = addDetailBlock(headMesh, snoutW, snoutH, snoutD, headColor,
                        new THREE.Vector3(0, -headHeight * 0.1, headDepth * 0.5));
                    
                    // Pink nose
                    addDetailBlock(snout, snoutW * 0.5, snoutH * 0.4, snoutD * 0.2, 0xFFB6C1,
                        new THREE.Vector3(0, snoutH * 0.15, snoutD * 0.4));
                    
                    // HUGE round ears - almost as big as head!
                    const earS = headHeight * 0.55;
                    addDetailBlock(headMesh, earS * 0.8, earS, earS * 0.15, headColor,
                        new THREE.Vector3(-headWidth * 0.35, headHeight * 0.4, -headDepth * 0.1));
                    addDetailBlock(headMesh, earS * 0.8, earS, earS * 0.15, headColor,
                        new THREE.Vector3(headWidth * 0.35, headHeight * 0.4, -headDepth * 0.1));
                    // Pink inner ears
                    addDetailBlock(headMesh, earS * 0.5, earS * 0.7, earS * 0.08, 0xFFB6C1,
                        new THREE.Vector3(-headWidth * 0.35, headHeight * 0.42, -headDepth * 0.05));
                    addDetailBlock(headMesh, earS * 0.5, earS * 0.7, earS * 0.08, 0xFFB6C1,
                        new THREE.Vector3(headWidth * 0.35, headHeight * 0.42, -headDepth * 0.05));
                    
                    // BIG round eyes
                    const eyeS = headHeight * 0.2;
                    const leftEye = addDetailBlock(headMesh, eyeS, eyeS, eyeS * 0.5, 0x000000,
                        new THREE.Vector3(-headWidth * 0.22, headHeight * 0.1, headDepth * 0.38));
                    // Highlight
                    addDetailBlock(leftEye, eyeS * 0.25, eyeS * 0.25, eyeS * 0.2, 0xFFFFFF,
                        new THREE.Vector3(-eyeS * 0.2, eyeS * 0.2, eyeS * 0.2));
                    const rightEye = addDetailBlock(headMesh, eyeS, eyeS, eyeS * 0.5, 0x000000,
                        new THREE.Vector3(headWidth * 0.22, headHeight * 0.1, headDepth * 0.38));
                    addDetailBlock(rightEye, eyeS * 0.25, eyeS * 0.25, eyeS * 0.2, 0xFFFFFF,
                        new THREE.Vector3(-eyeS * 0.2, eyeS * 0.2, eyeS * 0.2));
                    
                    // Buck teeth!
                    addDetailBlock(headMesh, snoutW * 0.15, headHeight * 0.12, snoutW * 0.08, 0xFFFFF0,
                        new THREE.Vector3(-snoutW * 0.15, -headHeight * 0.22, headDepth * 0.6));
                    addDetailBlock(headMesh, snoutW * 0.15, headHeight * 0.12, snoutW * 0.08, 0xFFFFF0,
                        new THREE.Vector3(snoutW * 0.15, -headHeight * 0.22, headDepth * 0.6));
                    break;
                }
            }
            
            console.log(`  🐺 HEAD created (${headStyle}) with details on ${primaryHeadBone}`);
        }
    }
    
    // ════════════════════════════════════════════════════════════════
    // STEP 2: CREATE BLOCKS FOR ALL OTHER BONES (skip head/neck)
    // ════════════════════════════════════════════════════════════════
    // We want body/torso to be ONLY TWO blocks that cover all animated torso bone positions.
    // Limbs + tail remain bone-blocks, and head is handled above.
    let createdCount = 1; // Count the head block

    const isLimbBoneName = (lower: string) => LIMB_BONE_KEYWORDS.some(k => lower.includes(k));

    // Treat explicit tail bones as tail, but also common exporter "end" bones that often
    // represent the tail tip / end of spine chain.
    const isTailBoneName = (lower: string) => lower.includes('tail') || lower === 'spine_end';

    const isBodyBoneName = (lower: string) => {
        // Everything not head/neck, not limb, not tail is treated as body/torso for merging.
        // This intentionally catches spine/rib/pelvis/hips/etc across different rigs.
        if (isLimbBoneName(lower)) return false;
        if (isTailBoneName(lower)) return false;
        if (lower === 'root' || lower.includes('_rig')) return false;
        return true;
    };

    // Collect body bones for merging (in root-local space)
    const bodyBones: string[] = [];
    for (const [boneName] of bones) {
        const lowerName = boneName.toLowerCase();
        if (lowerName === 'root' || lowerName.includes('_rig')) continue;
        if (headBonesSet.has(boneName)) continue;
        if (!isBodyBoneName(lowerName)) continue;
        bodyBones.push(boneName);
    }

    // Split body bones into FRONT/BACK based on initial root-local Z distribution.
    // (We keep this grouping static; the bounds are recomputed every frame.)
    const bodyFrontBones: string[] = [];
    const bodyBackBones: string[] = [];
    if (bodyBones.length > 0) {
        clonedScene.updateMatrixWorld(true);
        root.updateMatrixWorld(true);
        const invRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();

        let minZ = Infinity;
        let maxZ = -Infinity;
        const zByBone = new Map<string, number>();
        const tmpPos = new THREE.Vector3();

        for (const b of bodyBones) {
            const bone = bones.get(b);
            if (!bone) continue;
            bone.getWorldPosition(tmpPos);
            tmpPos.applyMatrix4(invRoot);
            zByBone.set(b, tmpPos.z);
            minZ = Math.min(minZ, tmpPos.z);
            maxZ = Math.max(maxZ, tmpPos.z);
        }

        const splitZ = (minZ + maxZ) * 0.5;
        for (const b of bodyBones) {
            const z = zByBone.get(b);
            if (z === undefined) continue;
            if (z >= splitZ) bodyFrontBones.push(b);
            else bodyBackBones.push(b);
        }

        // Fallback: ensure both groups have something
        if (bodyFrontBones.length === 0 || bodyBackBones.length === 0) {
            const sorted = [...bodyBones].sort((a, b) => (zByBone.get(a) ?? 0) - (zByBone.get(b) ?? 0));
            const mid = Math.floor(sorted.length / 2);
            bodyBackBones.length = 0;
            bodyFrontBones.length = 0;
            bodyBackBones.push(...sorted.slice(0, mid));
            bodyFrontBones.push(...sorted.slice(mid));
        }
    }

    // Create the 2 merged torso blocks using optimized centroid mode (fixed size, position-only updates)
    if (bodyBones.length > 0) {
        const padding = new THREE.Vector3(blockSize * 0.25, blockSize * 0.25, blockSize * 0.25);
        const back = createCentroidBlock('TorsoBack', bodyBackBones, bodyColor, padding);
        const front = createCentroidBlock('TorsoFront', bodyFrontBones, bodyColor, padding);
        if (back) createdCount++;
        if (front) createdCount++;
        console.log(
            `  🧩 Merged body into 2 blocks (centroid mode): backBones=${bodyBackBones.length}, frontBones=${bodyFrontBones.length}`
        );
    }
    
    for (const [boneName, bone] of bones) {
        // Skip root bone and rig objects
        const lowerName = boneName.toLowerCase();
        if (lowerName === 'root' || lowerName.includes('_rig')) continue;
        
        // Skip head/neck bones (already handled above)
        if (headBonesSet.has(boneName)) continue;

        // Skip torso/body bones: they are merged into 2 dynamic blocks above
        if (isBodyBoneName(lowerName)) continue;
        
        // Determine color based on bone name
        let color = bodyColor;
        if (lowerName.includes('thigh') || lowerName.includes('shin') || lowerName.includes('foot') ||
            lowerName.includes('toe') || lowerName.includes('shoulder') || lowerName.includes('arm') ||
            lowerName.includes('wing') || lowerName.includes('fin')) {
            color = legColor;
        } else if (lowerName.includes('tail')) {
            color = tailColor;
        }
        
        // Standard block size for all bones
        const width = blockSize;
        const height = blockSize * 0.8;
        const depth = blockSize * 0.7;
        
        const mesh = createBoundBlock(boneName, width, height, depth, color);
        if (mesh) {
            createdCount++;
        }
    }
    
    console.log(`  🧱 Created ${createdCount} blocks for ${bones.size} bones (head + 2 merged torso + per-bone limbs/tail)`);
    
    // ════════════════════════════════════════════════════════════════
    // ADD DEBUG LABEL showing skeleton base and animal name
    // ════════════════════════════════════════════════════════════════
    const skeletonBaseName = findBestSkeletonBase(config.name);
    const labelText = `${config.name} [${skeletonBaseName}]`;
    
    // Create canvas for text
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    canvas.width = 512;
    canvas.height = 64;
    
    // Draw background
    context.fillStyle = 'rgba(0, 0, 0, 0.7)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw text
    context.font = 'bold 32px Arial';
    context.fillStyle = '#00FF00';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(labelText, canvas.width / 2, canvas.height / 2);
    
    // Create sprite
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture });
    const labelSprite = new THREE.Sprite(spriteMaterial);
    
    // Position above the animal (scale based on skeleton size)
    const labelHeight = skeletonSize * 1.5 + 1.0;
    labelSprite.position.set(0, labelHeight, 0);
    labelSprite.scale.set(2.0, 0.25, 1);
    labelSprite.name = 'SkeletonLabel';
    
    // Add to root
    root.add(labelSprite);
    
    // Current animation state
    let currentAction: THREE.AnimationAction | null = null;
    
    // Play animation function
    const playAnimation = (name: string, options?: { loop?: boolean; crossFade?: number }) => {
        const animKey = name.toLowerCase();
        const clip = animations.get(animKey);
        if (!clip) {
            console.warn(`🎬 Animation "${name}" not found for ${config.name}. Available: [${Array.from(animations.keys()).join(', ')}]`);
            return;
        }
        
        console.log(`🎬 Playing animation "${animKey}" for ${config.name}`);
        
        const newAction = mixer.clipAction(clip);
        newAction.setLoop(options?.loop !== false ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        
        if (currentAction && options?.crossFade) {
            currentAction.crossFadeTo(newAction, options.crossFade, true);
        } else if (currentAction) {
            currentAction.fadeOut(0.2);
        }
        
        newAction.reset().fadeIn(0.2).play();
        currentAction = newAction;
    };
    
    // Update function - syncs blocks to bone positions
    const update = (deltaTime: number) => {
        // Update animation mixer
        mixer.update(deltaTime);
        
        // Update skeleton matrices
        clonedScene.updateMatrixWorld(true);
        
        // Sync each block to its bone
        root.updateMatrixWorld(true);
        const invMatrix = new THREE.Matrix4().copy(root.matrixWorld).invert();

        // Reuse temp objects to avoid per-frame allocations
        const tmpWorldPos = new THREE.Vector3();
        const tmpWorldQuat = new THREE.Quaternion();
        const tmpBoxA = new THREE.Box3();
        const tmpBoxB = new THREE.Box3();
        const tmpCenter = new THREE.Vector3();
        const tmpSize = new THREE.Vector3();

        // Cache torso mesh + size so we can post-process TorsoFront/TorsoBack
        // after both have been placed. (Their own scale is overwritten by that
        // post-process, so the size has to be captured, not read back.)
        let torsoFront: { mesh: THREE.Mesh; size: THREE.Vector3 } | null = null;
        let torsoBack: { mesh: THREE.Mesh; size: THREE.Vector3 } | null = null;

        // Sync each block to its binding
        for (const binding of blockBindings) {
            if (binding.mode === 'bone') {
                const bone = bones.get(binding.boneName);
                if (!bone) continue;

                // Get bone world position and rotation
                bone.getWorldPosition(tmpWorldPos);
                bone.getWorldQuaternion(tmpWorldQuat);

                // Convert to root-local space
                const localPos = tmpWorldPos.clone().applyMatrix4(invMatrix);

                // Apply offset
                if (binding.followRotation) {
                    const offset = binding.offset.clone().applyQuaternion(tmpWorldQuat);
                    localPos.add(offset);
                } else {
                    // For fixed-rotation blocks (head), treat offset as root-local
                    localPos.add(binding.offset);
                }

                // Set block position
                binding.mesh.position.copy(localPos);

                // Set block rotation (only if followRotation is true)
                if (binding.followRotation) {
                    binding.mesh.quaternion.copy(tmpWorldQuat);
                }
            } else if (binding.mode === 'centroid') {
                // OPTIMIZED: Fixed size, only update centroid position
                let sumX = 0, sumY = 0, sumZ = 0;
                let count = 0;

                for (const boneName of binding.boneNames) {
                    const bone = bones.get(boneName);
                    if (!bone) continue;
                    bone.getWorldPosition(tmpWorldPos);
                    tmpWorldPos.applyMatrix4(invMatrix);
                    sumX += tmpWorldPos.x;
                    sumY += tmpWorldPos.y;
                    sumZ += tmpWorldPos.z;
                    count++;
                }

                if (count === 0) continue;

                // Just update position (size is fixed)
                binding.mesh.position.set(sumX / count, sumY / count, sumZ / count);
                binding.mesh.quaternion.set(0, 0, 0, 1);

                // Capture for post-processing
                if (binding.mesh.name === 'Block_TorsoFront') {
                    torsoFront = { mesh: binding.mesh, size: binding.fixedScale };
                } else if (binding.mesh.name === 'Block_TorsoBack') {
                    torsoBack = { mesh: binding.mesh, size: binding.fixedScale };
                }
            } else {
                // Legacy bounds mode (expensive - calculates size every frame)
                let minX = Infinity,
                    minY = Infinity,
                    minZ = Infinity;
                let maxX = -Infinity,
                    maxY = -Infinity,
                    maxZ = -Infinity;

                for (const boneName of binding.boneNames) {
                    const bone = bones.get(boneName);
                    if (!bone) continue;
                    bone.getWorldPosition(tmpWorldPos);
                    tmpWorldPos.applyMatrix4(invMatrix);
                    minX = Math.min(minX, tmpWorldPos.x);
                    minY = Math.min(minY, tmpWorldPos.y);
                    minZ = Math.min(minZ, tmpWorldPos.z);
                    maxX = Math.max(maxX, tmpWorldPos.x);
                    maxY = Math.max(maxY, tmpWorldPos.y);
                    maxZ = Math.max(maxZ, tmpWorldPos.z);
                }

                if (!Number.isFinite(minX) || !Number.isFinite(maxX)) continue;

                const centerX = (minX + maxX) * 0.5;
                const centerY = (minY + maxY) * 0.5;
                const centerZ = (minZ + maxZ) * 0.5;

                const sizeX = Math.max(maxX - minX + binding.padding.x * 2, 0.001);
                const sizeY = Math.max(maxY - minY + binding.padding.y * 2, 0.001);
                const sizeZ = Math.max(maxZ - minZ + binding.padding.z * 2, 0.001);

                binding.mesh.position.set(centerX, centerY, centerZ);
                binding.mesh.scale.set(sizeX, sizeY, sizeZ);
                binding.mesh.quaternion.set(0, 0, 0, 1);

                if (binding.mesh.name === 'Block_TorsoFront') {
                    torsoFront = { mesh: binding.mesh, size: new THREE.Vector3(sizeX, sizeY, sizeZ) };
                } else if (binding.mesh.name === 'Block_TorsoBack') {
                    torsoBack = { mesh: binding.mesh, size: new THREE.Vector3(sizeX, sizeY, sizeZ) };
                }
            }
        }

        // Post-process torso blocks:
        // - Make them equal-sized
        // - Make them bulkier sideways (X)
        // - Add gap between blocks and round them with internal sub-blocks
        if (torsoFront && torsoBack) {
            // Union AABB of the two already-computed torso AABBs (approx, but stable).
            const union = tmpBoxA.setFromCenterAndSize(torsoFront.mesh.position, torsoFront.size)
                .union(tmpBoxB.setFromCenterAndSize(torsoBack.mesh.position, torsoBack.size));
            const center = union.getCenter(tmpCenter);
            const unionSize = union.getSize(tmpSize);

            // Tuning knobs (visual): make torso chunkier sideways, with small gap
            const sidewaysBulk = 2.0; // wide horizontal body
            const torsoLengthScale = 0.70; // body length
            const torsoHeightScale = 0.55; // thinner vertical body
            const blockGap = 0.06; // small gap between front and back blocks

            const heightScale = Math.min(Math.max(torsoHeightScale, 0.35), 1.0);
            const sharedX = Math.max(unionSize.x, 0.001) * sidewaysBulk;
            const sharedY = Math.max(unionSize.y * heightScale, 0.001);

            // Split the union depth with a gap between blocks
            const totalZ = Math.max(unionSize.z * torsoLengthScale, 0.001);
            const gapSize = totalZ * blockGap;
            const sharedZ = Math.max((totalZ - gapSize) * 0.5, 0.001);

            // Position blocks with gap in between
            const halfTotalWithGap = (sharedZ + gapSize * 0.5);

            torsoBack.mesh.position.set(center.x, center.y, center.z - halfTotalWithGap);
            torsoFront.mesh.position.set(center.x, center.y, center.z + halfTotalWithGap);

            // Simple barrel shape - just scale the single box to be wider than tall
            torsoBack.mesh.scale.set(sharedX, sharedY, sharedZ);
            torsoFront.mesh.scale.set(sharedX, sharedY, sharedZ);
        }
    };
    
    // Dispose function
    const dispose = () => {
        mixer.stopAllAction();
        
        for (const mesh of blockMeshes) {
            mesh.geometry.dispose();
            if (mesh.material instanceof THREE.Material) {
                mesh.material.dispose();
            }
        }
        
        root.removeFromParent();
    };
    
    // Play idle animation by default
    if (animations.has('idle')) {
        playAnimation('idle');
        // Do one update to position blocks correctly
        update(0);
    }
    
    console.log(`✅ Skeleton animal ${config.name} loaded with ${blockMeshes.length} blocks, ${animations.size} animations`);
    
    return {
        root,
        skeleton: clonedScene,
        mixer,
        animations,
        currentAction,
        blockMeshes,
        playAnimation,
        update,
        dispose,
    };
}

/**
 * Get preset config for an animal type
 */
export function getSkeletonAnimalPreset(animalType: string): Partial<SkeletonAnimalConfig> {
    return matchByAnimalName(SKELETON_ANIMAL_PRESETS, animalType) ?? SKELETON_ANIMAL_PRESETS.dog ?? {};
}

/**
 * Create full config from world.json animal definition and preset
 */
export function createSkeletonAnimalConfig(
    animalDef: { name: string; glbUrl: string; animations: string[] },
    presetOverrides?: Partial<SkeletonAnimalConfig>
): SkeletonAnimalConfig {
    const preset = getSkeletonAnimalPreset(animalDef.name);
    
    return {
        name: animalDef.name,
        glbUrl: animalDef.glbUrl,
        animations: animalDef.animations,
        bodyColor: 0x8B4513,
        ...preset,
        ...presetOverrides,
    };
}

/**
 * Create a skeleton animal config for ANY animal type
 * Automatically selects the best skeleton base and applies appropriate appearance
 */
export function createAnimalConfigFromType(
    animalType: string,
    baseUrl: string = 'https://mini.bitmagic.ai/worlds/v3/animations/animals',
    overrides?: Partial<SkeletonAnimalConfig>
): SkeletonAnimalConfig {
    const skeletonBase = findBestSkeletonBase(animalType);
    const glbUrl = getSkeletonGlbUrl(skeletonBase, baseUrl);
    
    const skeletonAnimations: Record<SkeletonBase, string[]> = {
        chicken: ['idle', 'run', 'walk'],
        deer: ['idle', 'run', 'walk'],
        dog: ['idle', 'run', 'walk'],
        horse: ['eat', 'idle', 'run', 'walk'],
        kitty: ['idle', 'run', 'walk'],
        pinguin: ['idle', 'run', 'walk'],
        tiger: ['idle', 'idle_rare', 'run', 'walk'],
    };
    
    const appearancePreset = getSkeletonAnimalPreset(animalType);
    
    console.log(`🦴 Creating ${animalType} using ${skeletonBase} skeleton`);
    
    return {
        name: animalType,
        glbUrl,
        animations: skeletonAnimations[skeletonBase],
        bodyColor: 0x8B4513,
        ...appearancePreset,
        ...overrides,
    };
}
