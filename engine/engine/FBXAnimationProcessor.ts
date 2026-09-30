/**
 * FBX Animation Processor
 * 
 * Handles loading FBX animation files, validating humanoid skeleton,
 * and converting to GLB format for use in the game engine.
 * 
 * This processor runs in the game iframe (which has Three.js) and communicates
 * with the Creator UI via postMessage.
 */

import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ensureNormalAttribute } from 'engine/utils/ensureNormalAttribute.js';

/**
 * Required bones for a valid humanoid animation.
 * We check for Mixamo naming convention as that's what our system uses.
 */
const REQUIRED_HUMANOID_BONES = [
    // Core structure - at least one of these patterns must match
    { patterns: ['hips', 'pelvis', 'root'], required: true, name: 'Hips/Root' },
    { patterns: ['spine'], required: true, name: 'Spine' },
    
    // Upper body
    { patterns: ['head'], required: true, name: 'Head' },
    
    // Arms (at least one side)
    { patterns: ['arm', 'shoulder'], required: true, name: 'Arm' },
    { patterns: ['hand', 'wrist'], required: true, name: 'Hand' },
    
    // Legs (at least one side)
    { patterns: ['leg', 'thigh', 'upleg'], required: true, name: 'Leg' },
    { patterns: ['foot', 'ankle'], required: true, name: 'Foot' },
];

export interface FBXValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    boneCount: number;
    animationCount: number;
    animationNames: string[];
    duration: number;
    /** Measured skeleton height in the file's native units */
    skeletonHeight: number;
    /**
     * Scale factor to convert from file units to meters.
     * 0.01 for centimeter-based skeletons (Mixamo FBX), 1.0 for meter-based.
     * Detected by measuring skeleton vertical extent: if > 50 units, assumes cm.
     */
    unitScale: number;
}

export interface FBXConversionResult {
    success: boolean;
    error?: string;
    glbBlob?: Blob;
    validation?: FBXValidationResult;
}

/**
 * Load and validate an FBX file
 */
export async function loadAndValidateFBX(file: File): Promise<{ scene: THREE.Group; validation: FBXValidationResult }> {
    const loader = new FBXLoader();
    
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        
        reader.onload = async (event) => {
            try {
                const arrayBuffer = event.target?.result as ArrayBuffer;
                const scene = loader.parse(arrayBuffer, '');
                
                const validation = validateHumanoidSkeleton(scene);
                
                resolve({ scene, validation });
            } catch (error) {
                reject(new Error(`Failed to parse FBX file: ${error instanceof Error ? error.message : 'Unknown error'}`));
            }
        };
        
        reader.onerror = () => reject(new Error('Failed to read FBX file'));
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Validate that the FBX contains a humanoid skeleton
 */
function validateHumanoidSkeleton(scene: THREE.Group): FBXValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const foundBones = new Set<string>();
    const boneNames: string[] = [];
    let boneCount = 0;
    
    // Collect all bone names and measure skeleton vertical extent
    let minY = Infinity;
    let maxY = -Infinity;
    scene.traverse((obj) => {
        if ((obj as THREE.Bone).isBone) {
            boneCount++;
            boneNames.push(obj.name);
            const boneName = obj.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            foundBones.add(boneName);
            foundBones.add(obj.name.toLowerCase());
            
            // Track vertical extent using world position
            obj.updateWorldMatrix(true, false);
            const worldPos = new THREE.Vector3();
            obj.getWorldPosition(worldPos);
            if (worldPos.y < minY) minY = worldPos.y;
            if (worldPos.y > maxY) maxY = worldPos.y;
        }
    });
    
    console.log(`🦴 FBX bones (${boneCount}): ${boneNames.join(', ')}`);
    
    // Check for required bones
    for (const requirement of REQUIRED_HUMANOID_BONES) {
        const found = requirement.patterns.some(pattern => {
            for (const bone of foundBones) {
                if (bone.includes(pattern)) {
                    return true;
                }
            }
            return false;
        });
        
        if (!found && requirement.required) {
            errors.push(`Missing required bone: ${requirement.name} (looking for: ${requirement.patterns.join(', ')})`);
        }
    }
    
    // Check for animations
    const animations = scene.animations || [];
    const animationNames = animations.map(a => a.name);
    const totalDuration = animations.reduce((sum, a) => sum + a.duration, 0);
    
    if (animations.length === 0) {
        errors.push('No animations found in FBX file');
    }
    
    // Warnings for potential issues
    if (boneCount < 10) {
        warnings.push(`Low bone count (${boneCount}) - may not be a full humanoid rig`);
    }
    
    if (boneCount > 200) {
        warnings.push(`High bone count (${boneCount}) - animation may have extra bones that won't be used`);
    }
    
    const skeletonHeight = (minY === Infinity) ? 0 : (maxY - minY);
    // Heuristic: a human skeleton > 50 native units tall is almost certainly in centimeters.
    // Typical Mixamo FBX skeletons are ~170-180 cm. Meter-based skeletons are ~1.7-1.8 m.
    const unitScale = skeletonHeight > 50 ? 0.01 : 1.0;
    
    if (unitScale === 0.01) {
        console.log(`📏 Skeleton height: ${skeletonHeight.toFixed(1)} units → detected centimeter scale (unitScale: 0.01)`);
    } else {
        console.log(`📏 Skeleton height: ${skeletonHeight.toFixed(3)} units → detected meter scale (unitScale: 1.0)`);
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        boneCount,
        animationCount: animations.length,
        animationNames,
        duration: totalDuration,
        skeletonHeight,
        unitScale,
    };
}

/**
 * Dispose all textures referenced by a material, then dispose the material itself.
 */
function disposeMaterialWithTextures(mat: THREE.Material): void {
    const m = mat as THREE.MeshStandardMaterial;
    const texProps = ['map', 'normalMap', 'emissiveMap', 'roughnessMap',
        'metalnessMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap',
        'envMap', 'lightMap', 'specularMap'] as const;
    for (const prop of texProps) {
        const tex = (m as unknown as Record<string, unknown>)[prop];
        if (tex instanceof THREE.Texture) tex.dispose();
    }
    mat.dispose();
}

function disposeMaterialsAndTextures(material: THREE.Material | THREE.Material[]): void {
    if (Array.isArray(material)) {
        material.forEach(disposeMaterialWithTextures);
    } else {
        disposeMaterialWithTextures(material);
    }
}

/**
 * Create a minimal 3-vertex geometry with valid skinIndex/skinWeight attributes
 * so the SkinnedMesh remains a valid GLTF skin reference.
 */
function createMinimalSkinnedGeometry(skinned: THREE.SkinnedMesh): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    // Tiny triangle at the origin
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0], 3));
    // Bind all 3 vertices to the first bone (index 0)
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    geo.setIndex([0, 1, 2]);
    ensureNormalAttribute(geo);
    // Copy bind matrices from original
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.001);
    return geo;
}

/**
 * Convert FBX scene to GLB blob.
 * Exports the skeleton and animations WITHOUT retargeting - keeps original Mixamo bone names.
 * The skeleton will be used directly as the animation source, with bone transforms
 * mapped to block character parts at runtime.
 * 
 * Mesh geometry is replaced with a minimal placeholder to keep the GLTF skin valid
 * while dramatically reducing file size (from ~9MB to <1MB).
 */
export async function convertFBXToGLB(
    scene: THREE.Group,
    animationName?: string,
): Promise<Blob> {
    const exporter = new GLTFExporter();

    // Keep original animations without any retargeting
    let animationsToExport = scene.animations || [];

    if (animationName && animationsToExport.length > 1) {
        const found = animationsToExport.find(a => a.name === animationName);
        if (found) animationsToExport = [found];
    }

    // Strip meshes to the bare minimum for a valid GLTF skeleton export.
    // GLTF requires at least one SkinnedMesh referencing the skeleton, but we
    // don't need the full character geometry (often 50k+ vertices). Replace with
    // a tiny 3-vertex placeholder and dispose all textures/materials/geometry.
    const simpleMaterial = new THREE.MeshBasicMaterial({ color: 0x808080 });
    const meshesToRemove: THREE.Mesh[] = [];
    let keptSkinned = false;

    scene.traverse(obj => {
        if ((obj as THREE.SkinnedMesh).isSkinnedMesh) {
            const skinned = obj as THREE.SkinnedMesh;
            disposeMaterialsAndTextures(skinned.material);

            if (!keptSkinned) {
                // Keep the first SkinnedMesh but replace its geometry with a minimal one
                // that preserves the skin binding (skinIndex/skinWeight)
                const oldGeo = skinned.geometry;
                const minGeo = createMinimalSkinnedGeometry(skinned);
                skinned.geometry = minGeo;
                oldGeo.dispose();
                skinned.material = simpleMaterial;
                keptSkinned = true;
            } else {
                meshesToRemove.push(skinned);
            }
        } else if ((obj as THREE.Mesh).isMesh) {
            disposeMaterialsAndTextures((obj as THREE.Mesh).material);
            meshesToRemove.push(obj as THREE.Mesh);
        }
    });

    // Remove non-essential meshes from the scene
    for (const mesh of meshesToRemove) {
        mesh.geometry.dispose();
        if (mesh.parent) mesh.parent.remove(mesh);
    }

    console.log(`[ConvertFBX] Stripped meshes for GLB export: kept 1 minimal skinned mesh, removed ${meshesToRemove.length}`);

    return new Promise((resolve, reject) => {
        exporter.parse(
            scene,
            (result) => {
                if (result instanceof ArrayBuffer) {
                    resolve(new Blob([result], { type: 'model/gltf-binary' }));
                } else {
                    const jsonString = JSON.stringify(result);
                    resolve(new Blob([jsonString], { type: 'model/gltf+json' }));
                }
            },
            (error) => {
                reject(new Error(`GLB export failed: ${error}`));
            },
            {
                binary: true,
                animations: animationsToExport,
                includeCustomExtensions: false,
            }
        );
    });
}

/**
 * Full pipeline: Load FBX, validate, convert to GLB.
 * Exports the Mixamo skeleton + animation without retargeting.
 * The skeleton will be used as the animation source at runtime.
 */
export async function processFBXAnimation(file: File): Promise<FBXConversionResult> {
    try {
        console.log(`🎬 Processing FBX animation: ${file.name}`);
        
        const { scene, validation } = await loadAndValidateFBX(file);
        
        if (!validation.valid) {
            return {
                success: false,
                error: `Validation failed: ${validation.errors.join('; ')}`,
                validation,
            };
        }
        
        if (validation.warnings.length > 0) {
            console.warn('FBX validation warnings:', validation.warnings);
        }
        
        console.log(`✅ FBX validated: ${validation.boneCount} bones, ${validation.animationCount} animations`);
        
        for (const clip of scene.animations || []) {
            const trackBones = new Set<string>();
            for (const track of clip.tracks) {
                const dotIndex = track.name.indexOf('.');
                if (dotIndex > 0) {
                    trackBones.add(track.name.substring(0, dotIndex));
                }
            }
            console.log(`🎬 Animation "${clip.name}" (${clip.duration.toFixed(2)}s): ${clip.tracks.length} tracks, bones: ${Array.from(trackBones).join(', ')}`);
        }

        console.log('🦴 Exporting Mixamo skeleton + animation (no retargeting)');
        
        const glbBlob = await convertFBXToGLB(scene);
        
        console.log(`✅ Converted to GLB: ${(glbBlob.size / 1024).toFixed(1)} KB`);
        
        return {
            success: true,
            glbBlob,
            validation,
        };
        
    } catch (error) {
        console.error('FBX processing error:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error during FBX processing',
        };
    }
}

/**
 * Debug function: Load FBX with skin and display it in the scene with its animation playing.
 * This tests that the FBX animation works correctly on its original mesh before retargeting.
 * 
 * Call from browser console: window.testFBXWithSkin(file, scene)
 */
export async function testFBXWithSkin(
    file: File,
    scene: THREE.Scene,
    position: THREE.Vector3 = new THREE.Vector3(0, 0, 0)
): Promise<{ mixer: THREE.AnimationMixer; cleanup: () => void } | null> {
    try {
        console.log(`🧪 Testing FBX with skin: ${file.name}`);
        
        const { scene: fbxScene, validation } = await loadAndValidateFBX(file);
        
        if (!validation.valid) {
            console.error('FBX validation failed:', validation.errors);
            return null;
        }

        // Check if FBX has any meshes (skin)
        let hasMesh = false;
        fbxScene.traverse(child => {
            if ((child as THREE.Mesh).isMesh || (child as THREE.SkinnedMesh).isSkinnedMesh) {
                hasMesh = true;
            }
        });

        if (!hasMesh) {
            console.error('❌ FBX has no mesh/skin. Download from Mixamo with "With Skin" option checked.');
            return null;
        }

        // Scale and position the FBX
        fbxScene.scale.setScalar(0.01); // Mixamo FBX is typically in cm, convert to meters
        fbxScene.position.copy(position);
        
        // Add to scene
        scene.add(fbxScene);
        console.log('✅ FBX mesh added to scene at', position.toArray());

        // Set up animation
        const mixer = new THREE.AnimationMixer(fbxScene);
        const animations = fbxScene.animations || [];
        
        if (animations.length > 0) {
            const clip = animations[0]!;
            const action = mixer.clipAction(clip);
            action.play();
            console.log(`▶️ Playing animation "${clip.name}" (${clip.duration.toFixed(2)}s)`);
        } else {
            console.warn('No animations in FBX');
        }

        // Return mixer and cleanup function
        const cleanup = () => {
            mixer.stopAllAction();
            scene.remove(fbxScene);
            fbxScene.traverse(child => {
                if ((child as THREE.Mesh).geometry) {
                    (child as THREE.Mesh).geometry.dispose();
                }
                if ((child as THREE.Mesh).material) {
                    const mat = (child as THREE.Mesh).material;
                    if (Array.isArray(mat)) {
                        mat.forEach(m => m.dispose());
                    } else {
                        mat.dispose();
                    }
                }
            });
            console.log('🧹 FBX test cleaned up');
        };

        // Store globally for easy access
        (window as any).__fbxTestMixer = mixer;
        (window as any).__fbxTestCleanup = cleanup;
        
        console.log(`
📋 FBX Test Instructions:
1. Call this in your game loop to update animation:
   window.__fbxTestMixer.update(deltaTime);
   
2. To clean up when done:
   window.__fbxTestCleanup();
`);

        return { mixer, cleanup };
        
    } catch (error) {
        console.error('FBX test error:', error);
        return null;
    }
}
