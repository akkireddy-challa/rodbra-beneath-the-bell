/**
 * Animation Clip Utilities
 *
 * Pure utility functions for processing THREE.js AnimationClips:
 * - Root motion filtering, normalization, and measurement
 * - Bone name retargeting between skeleton conventions
 * - Animation diagnostics and debugging
 *
 * Extracted from CharacterAnimationController to keep that class focused
 * on animation state management and playback.
 */

import * as THREE from 'three';

/** Candidate root bone names for root motion detection */
const CANDIDATE_ROOT_NAMES = new Set<string>([
    'mixamorigHips', 'Hips', 'Root', 'Armature',
    'pelvis', 'Pelvis',
    'root',
    'UE5_Manny_DEFORM',
    'UE4_Mannequin_DEFORM',
]);

/** Root bone names for custom animation normalization */
const CUSTOM_ANIM_ROOT_NAMES = new Set<string>([
    'mixamorigHips', 'Hips', 'Root', 'Armature', 'mixamorig_Hips',
    'pelvis', 'Pelvis', 'root',
]);

/** Bone name mapping from Mixamo to Unreal Engine naming conventions */
const BONE_NAME_MAPPING: Record<string, string> = {
    // Root/Hips
    'mixamorigHips': 'pelvis',
    // Spine
    'mixamorigSpine': 'spine_01',
    'mixamorigSpine1': 'spine_02',
    'mixamorigSpine2': 'spine_04',
    // Neck/Head
    'mixamorigNeck': 'neck_01',
    'mixamorigHead': 'head',
    // Left Arm
    'mixamorigLeftShoulder': 'clavicle_l',
    'mixamorigLeftArm': 'upperarm_l',
    'mixamorigLeftForeArm': 'lowerarm_l',
    'mixamorigLeftHand': 'hand_l',
    // Right Arm
    'mixamorigRightShoulder': 'clavicle_r',
    'mixamorigRightArm': 'upperarm_r',
    'mixamorigRightForeArm': 'lowerarm_r',
    'mixamorigRightHand': 'hand_r',
    // Left Leg
    'mixamorigLeftUpLeg': 'thigh_l',
    'mixamorigLeftLeg': 'calf_l',
    'mixamorigLeftFoot': 'foot_l',
    'mixamorigLeftToeBase': 'ball_l',
    // Right Leg
    'mixamorigRightUpLeg': 'thigh_r',
    'mixamorigRightLeg': 'calf_r',
    'mixamorigRightFoot': 'foot_r',
    'mixamorigRightToeBase': 'ball_r',
};

/**
 * Build the set of candidate root names, optionally including a character name.
 */
function getCandidateRoots(characterName?: string): Set<string> {
    if (!characterName) return CANDIDATE_ROOT_NAMES;
    const roots = new Set(CANDIDATE_ROOT_NAMES);
    roots.add(characterName);
    return roots;
}

/**
 * Remove root motion from an AnimationClip.
 *
 * @param originalClip - The source animation clip
 * @param options.removeAllAxes - If true, zero all axes for root bones (for walk/run/jump).
 *   Otherwise, auto-detect axis policy per bone from delta analysis.
 * @param characterName - Optional character root name to include in candidate roots
 */
export function filterRootMotion(
    originalClip: THREE.AnimationClip,
    options?: { removeAllAxes?: boolean },
    characterName?: string
): THREE.AnimationClip {
    const candidateRoots = getCandidateRoots(characterName);
    const newTracks: THREE.KeyframeTrack[] = [];

    // Determine axis policy per candidate node
    const nodeAxisPolicy = new Map<string, 'zeroAll' | 'zeroY' | 'zeroXZ'>();
    if (options?.removeAllAxes) {
        for (const name of candidateRoots) nodeAxisPolicy.set(name, 'zeroAll');
    } else {
        for (const track of originalClip.tracks) {
            if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith('.position')) {
                const dot = track.name.lastIndexOf('.');
                const nodeName = dot >= 0 ? track.name.substring(0, dot) : track.name;
                if (!candidateRoots.has(nodeName)) continue;
                let minX = Infinity, maxX = -Infinity;
                let minY = Infinity, maxY = -Infinity;
                let minZ = Infinity, maxZ = -Infinity;
                const vals = track.values as Float32Array | number[];
                for (let i = 0; i < vals.length; i += 3) {
                    const x = vals[i] ?? 0;
                    const y = vals[i + 1] ?? 0;
                    const z = vals[i + 2] ?? 0;
                    if (x < minX) minX = x; if (x > maxX) maxX = x;
                    if (y < minY) minY = y; if (y > maxY) maxY = y;
                    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
                }
                const dx = Math.abs(maxX - minX);
                const dy = Math.abs(maxY - minY);
                const dz = Math.abs(maxZ - minZ);
                if (dy > Math.max(dx, dz) * 2) nodeAxisPolicy.set(nodeName, 'zeroY'); else nodeAxisPolicy.set(nodeName, 'zeroXZ');
            }
        }
    }

    originalClip.tracks.forEach((track) => {
        const name = track.name;

        const targetsCandidate = (): { node: string; prop: string } | null => {
            const idx = name.indexOf('.position');
            if (idx === -1) return null;
            const nodeName = name.substring(0, idx);
            if (!candidateRoots.has(nodeName)) return null;
            const prop = name.substring(idx + '.position'.length);
            return { node: nodeName, prop };
        };

        const targetInfo = targetsCandidate();

        if (track instanceof THREE.VectorKeyframeTrack && targetInfo && targetInfo.prop === '') {
            const policy = nodeAxisPolicy.get(targetInfo.node) || 'zeroXZ';
            const filteredValues = new Float32Array(track.values.length);
            for (let i = 0; i < track.values.length; i += 3) {
                const x = track.values[i] || 0;
                const y = track.values[i + 1] || 0;
                const z = track.values[i + 2] || 0;
                if (policy === 'zeroAll') {
                    filteredValues[i] = 0;
                    filteredValues[i + 1] = 0;
                    filteredValues[i + 2] = 0;
                } else if (policy === 'zeroY') {
                    filteredValues[i] = x;
                    filteredValues[i + 1] = 0;
                    filteredValues[i + 2] = z;
                } else {
                    filteredValues[i] = 0;
                    filteredValues[i + 1] = y;
                    filteredValues[i + 2] = 0;
                }
            }
            newTracks.push(new THREE.VectorKeyframeTrack(name, track.times, filteredValues));
        } else if (track instanceof THREE.NumberKeyframeTrack && targetInfo && targetInfo.prop.length) {
            const axis = targetInfo.prop.toLowerCase();
            const policy = nodeAxisPolicy.get(targetInfo.node) || 'zeroXZ';
            if (policy === 'zeroAll') {
                const zeros = new Float32Array(track.values.length);
                newTracks.push(new THREE.NumberKeyframeTrack(name, track.times, zeros));
            } else if (policy === 'zeroY') {
                if (axis.includes('[y]')) {
                    const zeros = new Float32Array(track.values.length);
                    newTracks.push(new THREE.NumberKeyframeTrack(name, track.times, zeros));
                } else {
                    newTracks.push(track);
                }
            } else {
                if (axis.includes('[x]') || axis.includes('[z]')) {
                    const zeros = new Float32Array(track.values.length);
                    newTracks.push(new THREE.NumberKeyframeTrack(name, track.times, zeros));
                } else {
                    newTracks.push(track);
                }
            }
        } else {
            newTracks.push(track);
        }
    });

    return new THREE.AnimationClip(originalClip.name, originalClip.duration, newTracks);
}

/**
 * Measure native root-motion speed (distance per second) along the dominant axis.
 *
 * @param clip - The animation clip to measure
 * @param characterName - Optional character root name
 * @param uniformScale - World-space uniform scale of the character (default 1)
 */
export function measureRootMotionSpeed(
    clip: THREE.AnimationClip,
    characterName?: string,
    uniformScale: number = 1
): number {
    const candidateRoots = getCandidateRoots(characterName);
    let bestDistance = 0;
    const bestDuration = Math.max(clip.duration, 1e-6);
    for (const track of clip.tracks) {
        if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith('.position')) {
            const dot = track.name.lastIndexOf('.');
            const nodeName = dot >= 0 ? track.name.substring(0, dot) : track.name;
            if (!candidateRoots.has(nodeName)) continue;
            const vals = track.values as Float32Array | number[];
            if (vals.length < 6) continue;
            const x0 = vals[0] || 0;
            const y0 = vals[1] || 0;
            const z0 = vals[2] || 0;
            const xn = vals[vals.length - 3] || 0;
            const yn = vals[vals.length - 2] || 0;
            const zn = vals[vals.length - 1] || 0;
            const dx = xn - x0;
            const dy = yn - y0;
            const dz = zn - z0;
            const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
            let dist = 0;
            if (ay > ax && ay > az) dist = ay; else if (ax > az) dist = ax; else dist = az;
            dist = dist * uniformScale;
            if (dist > bestDistance) bestDistance = dist;
        }
    }
    return bestDistance / bestDuration;
}

/**
 * Normalize idle animation root motion by subtracting the first-frame position
 * from all frames so the clip starts at 0,0,0.
 *
 * @param originalClip - The idle animation clip
 * @param characterName - Optional character root name
 */
export function normalizeIdleRootMotion(
    originalClip: THREE.AnimationClip,
    characterName?: string
): THREE.AnimationClip {
    const candidateRoots = getCandidateRoots(characterName);
    const newTracks: THREE.KeyframeTrack[] = [];

    // Capture first-frame offsets for each candidate node
    const firstFrameOffset = new Map<string, { x: number; y: number; z: number }>();
    for (const track of originalClip.tracks) {
        if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith('.position')) {
            const dot = track.name.lastIndexOf('.');
            const nodeName = dot >= 0 ? track.name.substring(0, dot) : track.name;
            if (!candidateRoots.has(nodeName)) continue;
            const vals = track.values as Float32Array | number[];
            if (vals.length >= 3 && !firstFrameOffset.has(nodeName)) {
                firstFrameOffset.set(nodeName, { x: vals[0] || 0, y: vals[1] || 0, z: vals[2] || 0 });
            }
        }
    }

    for (const track of originalClip.tracks) {
        const name = track.name;
        if (track instanceof THREE.VectorKeyframeTrack && name.endsWith('.position')) {
            const dot = name.lastIndexOf('.');
            const nodeName = dot >= 0 ? name.substring(0, dot) : name;
            const off = firstFrameOffset.get(nodeName);
            if (off) {
                const vals = track.values as Float32Array | number[];
                const out = new Float32Array(vals.length);
                for (let i = 0; i < vals.length; i += 3) {
                    out[i] = (vals[i] || 0) - off.x;
                    out[i + 1] = (vals[i + 1] || 0) - off.y;
                    out[i + 2] = (vals[i + 2] || 0) - off.z;
                }
                newTracks.push(new THREE.VectorKeyframeTrack(name, (track as any).times, out));
            } else {
                newTracks.push(track);
            }
        } else if (track instanceof THREE.NumberKeyframeTrack && name.includes('.position[')) {
            const dot = name.indexOf('.position');
            const nodeName = dot >= 0 ? name.substring(0, dot) : name;
            const axis = name.toLowerCase().includes('[x]') ? 'x' : name.toLowerCase().includes('[y]') ? 'y' : name.toLowerCase().includes('[z]') ? 'z' : '';
            const off = firstFrameOffset.get(nodeName);
            if (off && axis) {
                const vals = track.values as Float32Array | number[];
                const out = new Float32Array(vals.length);
                const base = axis === 'x' ? off.x : axis === 'y' ? off.y : off.z;
                for (let i = 0; i < vals.length; i++) out[i] = (vals[i] || 0) - base;
                newTracks.push(new THREE.NumberKeyframeTrack(name, (track as any).times, out));
            } else {
                newTracks.push(track);
            }
        } else {
            newTracks.push(track);
        }
    }

    return new THREE.AnimationClip(originalClip.name, originalClip.duration, newTracks);
}

/**
 * Normalize root motion for custom animations by subtracting the first-frame position.
 * Prevents unwanted displacement during one-shot animations.
 */
export function normalizeCustomAnimationRootMotion(originalClip: THREE.AnimationClip): THREE.AnimationClip {
    const newTracks: THREE.KeyframeTrack[] = [];

    originalClip.tracks.forEach((track) => {
        const trackName = track.name;

        let isRootPositionTrack = false;
        for (const rootName of CUSTOM_ANIM_ROOT_NAMES) {
            if (trackName === `${rootName}.position` || trackName.startsWith(`${rootName}.position[`)) {
                isRootPositionTrack = true;
                break;
            }
        }

        if (isRootPositionTrack && track instanceof THREE.VectorKeyframeTrack) {
            const filteredValues = new Float32Array(track.values.length);
            const firstX = track.values[0] || 0;
            const firstY = track.values[1] || 0;
            const firstZ = track.values[2] || 0;
            for (let i = 0; i < track.values.length; i += 3) {
                filteredValues[i] = (track.values[i] || 0) - firstX;
                filteredValues[i + 1] = (track.values[i + 1] || 0) - firstY;
                filteredValues[i + 2] = (track.values[i + 2] || 0) - firstZ;
            }
            newTracks.push(new THREE.VectorKeyframeTrack(trackName, track.times, filteredValues));
        } else if (isRootPositionTrack && track instanceof THREE.NumberKeyframeTrack) {
            const filteredValues = new Float32Array(track.values.length);
            const firstValue = track.values[0] || 0;
            for (let i = 0; i < track.values.length; i++) {
                filteredValues[i] = (track.values[i] || 0) - firstValue;
            }
            newTracks.push(new THREE.NumberKeyframeTrack(trackName, track.times, filteredValues));
        } else {
            newTracks.push(track);
        }
    });

    return new THREE.AnimationClip(originalClip.name + '_normalized', originalClip.duration, newTracks);
}

/**
 * Retarget an animation clip's bone names from one skeleton convention to another.
 * Maps Mixamo bone names to Unreal Engine equivalents.
 *
 * @param originalClip - The source animation clip
 * @param characterBoneNames - Set of bone names present in the target character
 */
export function retargetAnimationToCharacterSkeleton(
    originalClip: THREE.AnimationClip,
    characterBoneNames: Set<string>
): THREE.AnimationClip {
    const newTracks: THREE.KeyframeTrack[] = [];

    originalClip.tracks.forEach((track: THREE.KeyframeTrack) => {
        const trackName = track.name;
        const dotIndex = trackName.indexOf('.');
        if (dotIndex > 0) {
            const originalBoneName = trackName.substring(0, dotIndex);
            const property = trackName.substring(dotIndex);

            const mappedBoneName = BONE_NAME_MAPPING[originalBoneName];

            if (mappedBoneName && characterBoneNames.has(mappedBoneName)) {
                const newTrackName = mappedBoneName + property;
                if (track instanceof THREE.VectorKeyframeTrack) {
                    newTracks.push(new THREE.VectorKeyframeTrack(newTrackName, track.times, track.values));
                } else if (track instanceof THREE.QuaternionKeyframeTrack) {
                    newTracks.push(new THREE.QuaternionKeyframeTrack(newTrackName, track.times, track.values));
                } else if (track instanceof THREE.NumberKeyframeTrack) {
                    newTracks.push(new THREE.NumberKeyframeTrack(newTrackName, track.times, track.values));
                } else {
                    newTracks.push(track.clone());
                }
            } else {
                if (characterBoneNames.has(originalBoneName)) {
                    newTracks.push(track);
                }
            }
        } else {
            newTracks.push(track);
        }
    });

    return new THREE.AnimationClip(originalClip.name + '_retargeted', originalClip.duration, newTracks);
}

/**
 * Find the bone that carries root motion (typically hips/root bone).
 */
export function findRootMotionBone(root: THREE.Object3D): THREE.Object3D | null {
    let hips: THREE.Object3D | null = null;
    let firstBone: THREE.Object3D | null = null;
    root.traverse((obj) => {
        if ((obj as any).isBone) {
            if (!firstBone) firstBone = obj;
            const n = obj.name.toLowerCase();
            if (n.includes('hips') || n === 'root' || n.includes('pelvis')) {
                hips = obj;
            }
        }
    });
    return hips ?? firstBone;
}

/**
 * Build a list of potential root-motion targets by scanning clip position tracks.
 */
export function collectRootMotionTargets(root: THREE.Object3D, clips: THREE.AnimationClip[]): THREE.Object3D[] {
    const names = new Set<string>();
    for (const clip of clips) {
        for (const track of clip.tracks) {
            if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith('.position')) {
                const dot = track.name.lastIndexOf('.');
                const nodeName = dot >= 0 ? track.name.substring(0, dot) : track.name;
                names.add(nodeName);
            }
        }
    }
    const targets: THREE.Object3D[] = [];
    names.forEach((n) => {
        const node = root.getObjectByName(n);
        if (!node) return;
        const lname = n.toLowerCase();
        const isBone = (node as any).isBone === true;
        if (!isBone || lname.includes('armature') || lname === 'root' || lname.includes('hips')) {
            targets.push(node);
        }
    });
    return targets;
}

/**
 * Log position track deltas for debugging root motion.
 */
export function logPositionTrackDeltas(clip: THREE.AnimationClip): void {
    console.log(`\n=== POSITION DELTA ANALYSIS: ${clip.name} ===`);
    for (const track of clip.tracks) {
        const name = track.name;
        if (track instanceof THREE.VectorKeyframeTrack && name.endsWith('.position')) {
            let minX = Infinity, maxX = -Infinity;
            let minY = Infinity, maxY = -Infinity;
            let minZ = Infinity, maxZ = -Infinity;
            const vals = track.values as Float32Array | number[];
            for (let i = 0; i < vals.length; i += 3) {
                const x = vals[i] ?? 0;
                const y = vals[i + 1] ?? 0;
                const z = vals[i + 2] ?? 0;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }
            const dx = Math.abs(maxX - minX);
            const dy = Math.abs(maxY - minY);
            const dz = Math.abs(maxZ - minZ);
            const dxz = Math.hypot(dx, dz);
            console.log(`pos ${name}: Δx=${dx.toFixed(3)} Δy=${dy.toFixed(3)} Δz=${dz.toFixed(3)} | Δxz=${dxz.toFixed(3)}`);
        } else if (track instanceof THREE.NumberKeyframeTrack && name.includes('.position[')) {
            const vals = track.values as Float32Array | number[];
            let minV = Infinity, maxV = -Infinity;
            for (let i = 0; i < vals.length; i++) {
                const v = vals[i] ?? 0;
                if (v < minV) minV = v; if (v > maxV) maxV = v;
            }
            const d = Math.abs(maxV - minV);
            console.log(`pos-comp ${name}: Δ=${d.toFixed(3)}`);
        }
    }
    console.log(`=== END POSITION DELTA ANALYSIS: ${clip.name} ===\n`);
}

/**
 * Log detailed diagnostics for an animation clip's binding to a character skeleton.
 */
export function logAnimationDiagnostics(
    clip: THREE.AnimationClip,
    character: THREE.Object3D,
    mixer: THREE.AnimationMixer
): void {
    const boundCount = { total: 0, bound: 0, unbound: 0 };
    const unboundTrackNames: string[] = [];
    let identityQuatTracks = 0;

    for (const track of clip.tracks) {
        boundCount.total++;
        const dotIndex = track.name.indexOf('.');
        if (dotIndex <= 0) continue;

        const nodeName = track.name.substring(0, dotIndex);
        const property = track.name.substring(dotIndex + 1);
        const node = THREE.PropertyBinding.findNode(mixer.getRoot(), nodeName);

        if (node) {
            boundCount.bound++;
        } else {
            boundCount.unbound++;
            unboundTrackNames.push(`${nodeName} (${property})`);
        }

        if (property === 'quaternion' && track.values.length >= 4) {
            let allIdentity = true;
            const vals = track.values;
            for (let i = 0; i < vals.length; i += 4) {
                if (Math.abs(vals[i]!) > 0.001 || Math.abs(vals[i + 1]!) > 0.001 ||
                    Math.abs(vals[i + 2]!) > 0.001 || Math.abs(vals[i + 3]! - 1) > 0.001) {
                    allIdentity = false;
                    break;
                }
            }
            if (allIdentity) identityQuatTracks++;
        }
    }

    console.log(`[AnimDiag] Animation "${clip.name}": ${clip.duration.toFixed(2)}s, ${boundCount.total} tracks → ${boundCount.bound} bound, ${boundCount.unbound} unbound`);

    if (identityQuatTracks > 0) {
        console.warn(`[AnimDiag] ⚠️ ${identityQuatTracks} quaternion tracks have only identity data (no rotation)`);
    }

    if (boundCount.unbound > 0) {
        const uniqueUnbound = [...new Set(unboundTrackNames.map(t => t.split(' (')[0]))];
        console.warn(`[AnimDiag] ❌ Unbound nodes (${uniqueUnbound.length}): ${uniqueUnbound.join(', ')}`);
    }

    if (boundCount.bound === 0 && boundCount.total > 0) {
        console.error(`[AnimDiag] 🚨 ZERO tracks bound to character! Animation will show T-pose.`);
        const sampleTracks = clip.tracks.slice(0, 5).map(t => t.name);
        console.error(`[AnimDiag] Sample track names: ${sampleTracks.join(', ')}`);
        const nodeNames: string[] = [];
        character.traverse(child => {
            if ((child as THREE.Bone).isBone) nodeNames.push(child.name);
        });
        console.error(`[AnimDiag] Character bones: ${nodeNames.slice(0, 30).join(', ')}${nodeNames.length > 30 ? '...' : ''}`);
    }
}

/**
 * Suppress Three.js PropertyBinding warnings about missing animation targets.
 * Call once during initialization.
 */
export function suppressThreeJSWarnings(): void {
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
        const message = args[0];
        if (typeof message === 'string' && message.includes('THREE.PropertyBinding: No target node found for track:')) {
            return;
        }
        originalWarn.apply(console, args);
    };
}

/**
 * Scale all position keyframe values in an animation clip.
 * Use this to convert centimeter-unit animations to meters (scale = 0.01).
 *
 * Only position tracks are affected; rotation and scale tracks are unit-independent.
 * Returns a new clip — the original is not modified.
 */
export function scaleClipPositions(
    originalClip: THREE.AnimationClip,
    scale: number
): THREE.AnimationClip {
    if (scale === 1) return originalClip;

    const newTracks: THREE.KeyframeTrack[] = [];

    for (const track of originalClip.tracks) {
        if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith('.position')) {
            const scaledValues = new Float32Array(track.values.length);
            for (let i = 0; i < track.values.length; i++) {
                scaledValues[i] = (track.values[i] || 0) * scale;
            }
            newTracks.push(new THREE.VectorKeyframeTrack(track.name, track.times, scaledValues));
        } else if (track instanceof THREE.NumberKeyframeTrack && track.name.includes('.position[')) {
            const scaledValues = new Float32Array(track.values.length);
            for (let i = 0; i < track.values.length; i++) {
                scaledValues[i] = (track.values[i] || 0) * scale;
            }
            newTracks.push(new THREE.NumberKeyframeTrack(track.name, track.times, scaledValues));
        } else {
            newTracks.push(track);
        }
    }

    return new THREE.AnimationClip(
        originalClip.name,
        originalClip.duration,
        newTracks
    );
}

/**
 * Detect whether an animation clip uses centimeter units by examining position
 * track magnitudes. Returns the estimated unit scale (0.01 for cm, 1.0 for meters).
 *
 * Heuristic: find the maximum absolute position value across all position tracks.
 * If > 10, the animation is almost certainly in centimeters (typical Mixamo bone
 * positions are 50-180 cm; meter-based values are 0.5-1.8 m).
 */
export function detectClipUnitScale(clip: THREE.AnimationClip): number {
    let maxAbsPos = 0;

    for (const track of clip.tracks) {
        if (track instanceof THREE.VectorKeyframeTrack && track.name.endsWith('.position')) {
            const vals = track.values as Float32Array | number[];
            for (let i = 0; i < vals.length; i++) {
                const abs = Math.abs(vals[i] || 0);
                if (abs > maxAbsPos) maxAbsPos = abs;
            }
        } else if (track instanceof THREE.NumberKeyframeTrack && track.name.includes('.position[')) {
            const vals = track.values as Float32Array | number[];
            for (let i = 0; i < vals.length; i++) {
                const abs = Math.abs(vals[i] || 0);
                if (abs > maxAbsPos) maxAbsPos = abs;
            }
        }
    }

    // Threshold: if any position value exceeds 10, it's cm. Meter-based humanoid
    // animations rarely have bone positions beyond ~2.5m from origin.
    if (maxAbsPos > 10) {
        return 0.01;
    }
    return 1.0;
}

/**
 * Make an AnimationClip seamlessly loopable by blending the tail back into the head.
 *
 * For each track, keyframes in the last `blendDuration` seconds are interpolated
 * toward their frame-0 values so the final frame matches the first frame exactly.
 *
 * @param originalClip - The clip to make loopable (not mutated)
 * @param blendDuration - Seconds to blend at the end. Default 0.5s, capped at 30% of clip length.
 * @returns A new loopable AnimationClip
 */
export function makeClipLoopable(
    originalClip: THREE.AnimationClip,
    blendDuration: number = 0.5
): THREE.AnimationClip {
    const duration = originalClip.duration;
    if (duration <= 0) return originalClip;

    // Cap blend at 30% of clip length
    const maxBlend = duration * 0.3;
    const actualBlend = Math.min(blendDuration, maxBlend);
    const blendStart = duration - actualBlend;

    const newTracks: THREE.KeyframeTrack[] = [];

    for (const track of originalClip.tracks) {
        const times = track.times;
        const values = track.values;
        const isQuaternion = track instanceof THREE.QuaternionKeyframeTrack;
        const isPosition = track instanceof THREE.VectorKeyframeTrack && track.name.endsWith('.position');

        if (!isQuaternion && !isPosition) {
            // Pass through non-spatial tracks unchanged
            newTracks.push(track.clone());
            continue;
        }

        const stride = isQuaternion ? 4 : 3;

        // Get the frame-0 values
        const startValues = new Float32Array(stride);
        for (let j = 0; j < stride; j++) {
            startValues[j] = values[j] ?? 0;
        }

        const newValues = new Float32Array(values.length);
        newValues.set(values);

        for (let i = 0; i < times.length; i++) {
            const t = times[i] ?? 0;
            if (t < blendStart) continue;

            // Blend factor: 0 at blendStart, 1 at duration
            const blend = Math.min((t - blendStart) / actualBlend, 1.0);
            const offset = i * stride;

            if (isQuaternion) {
                // Slerp toward frame-0 quaternion
                const qCurrent = new THREE.Quaternion(
                    newValues[offset] ?? 0,
                    newValues[offset + 1] ?? 0,
                    newValues[offset + 2] ?? 0,
                    newValues[offset + 3] ?? 0
                );
                const qStart = new THREE.Quaternion(
                    startValues[0] ?? 0,
                    startValues[1] ?? 0,
                    startValues[2] ?? 0,
                    startValues[3] ?? 0
                );
                qCurrent.slerp(qStart, blend);
                newValues[offset] = qCurrent.x;
                newValues[offset + 1] = qCurrent.y;
                newValues[offset + 2] = qCurrent.z;
                newValues[offset + 3] = qCurrent.w;
            } else {
                // Lerp toward frame-0 position
                for (let j = 0; j < stride; j++) {
                    const current = newValues[offset + j] ?? 0;
                    const start = startValues[j] ?? 0;
                    newValues[offset + j] = current + (start - current) * blend;
                }
            }
        }

        if (isQuaternion) {
            newTracks.push(new THREE.QuaternionKeyframeTrack(track.name, Array.from(times), Array.from(newValues)));
        } else {
            newTracks.push(new THREE.VectorKeyframeTrack(track.name, Array.from(times), Array.from(newValues)));
        }
    }

    return new THREE.AnimationClip(
        originalClip.name,
        duration,
        newTracks
    );
}
