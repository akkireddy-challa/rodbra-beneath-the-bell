/**
 * VoxelEffects - Voxel-specific visual effect factories
 *
 * Provides cube-fragment disintegration for entity death and progressive
 * damage visuals based on HP ratio. Designed for voxel-style characters.
 *
 * Related files:
 * - engine/effects/HitEffects.ts — Sphere-particle blood/death effects
 * - engine/effects/DamageFlash.ts — Per-hit flash effect
 * - engine/IDamageable.ts — onDeathEffect callback definition
 */

import * as THREE from 'three';
import { keepShaderAlive } from 'engine/effects/ShaderKeepAlive.js';

// ── Voxel Death Effect ─────────────────────────────────────────────────

export interface VoxelDeathEffectConfig {
    /** Number of cube fragments (default: 12) */
    fragmentCount?: number;
    /** Fragment size as fraction of typical voxel size (default: 0.7) */
    fragmentScale?: number;
    /** Scatter radius in world units (default: 1.5) */
    scatterRadius?: number;
    /** Total animation duration in ms (default: 600) */
    duration?: number;
    /** Flash white at frame 0 for hit-confirm feel (default: true) */
    deathFlash?: boolean;
    /** Kill variant — affects physics, color tint, and fragment count */
    variant?: 'normal' | 'ice' | 'explosion' | 'boss';
    /** Max concurrent effects before switching to simplified mode (default: 6) */
    simplifyThreshold?: number;
    /** Getter for entity world position (called at effect trigger time) */
    getPosition: () => THREE.Vector3;
    /** Optional getter for source mesh to sample colors from */
    getSourceMesh?: () => THREE.Object3D | undefined;
}

const DEFAULT_VOXEL_DEATH = {
    fragmentCount: 12,
    fragmentScale: 0.7,
    scatterRadius: 1.5,
    duration: 600,
    deathFlash: true,
    variant: 'normal' as const,
    simplifyThreshold: 6,
};

const ICE_TINT = new THREE.Color(0x88ccff);

type VoxelDeathVariant = NonNullable<VoxelDeathEffectConfig['variant']>;

function getVariantMods(variant: VoxelDeathVariant): Partial<VoxelDeathEffectConfig> {
    switch (variant) {
        case 'ice': return { duration: 900, scatterRadius: 1.0 };
        case 'explosion': return { duration: 400, scatterRadius: 2.5 };
        case 'boss': return { fragmentCount: 24, duration: 800, scatterRadius: 2.0 };
        default: return {};
    }
}

/**
 * Cube fragments and chips build and dispose a material per piece; keeping the
 * program compiled between deaths — and pre-warming it at setup — avoids a
 * synchronous shader compile on the first kill (see ShaderKeepAlive).
 */
function keepFragmentShaderAlive(scene: THREE.Scene): void {
    keepShaderAlive(scene, 'voxel-effects:fragment', new THREE.MeshBasicMaterial({ transparent: true }));
}

function extractMeshColors(obj: THREE.Object3D): THREE.Color[] {
    const colors: THREE.Color[] = [];
    obj.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
            // Structural, not instanceof (the GhostMaterial doctrine): an
            // instanceof list misses MeshPhongMaterial — the class ladder's
            // whole 'direct' tier — and node-material swaps under WebGPU.
            const colour = (mat as { color?: unknown }).color;
            if (colour instanceof THREE.Color) {
                colors.push(colour.clone());
            }
        }
    });
    return colors;
}

/**
 * Create a voxel disintegration death effect.
 *
 * Returns a function matching the IDamageable.onDeathEffect signature:
 * `(killerDirection?: THREE.Vector3) => void`. Position and source mesh
 * are resolved at trigger time via getPosition/getSourceMesh in the config.
 *
 * Includes performance throttling when many effects are active simultaneously.
 */
export function createVoxelDeathEffect(
    scene: THREE.Scene,
    config: VoxelDeathEffectConfig
): (killerDirection?: THREE.Vector3) => void {
    const mods = getVariantMods(config.variant ?? 'normal');
    const cfg = { ...DEFAULT_VOXEL_DEATH, ...mods, ...config };

    let activeCount = 0;
    const sharedGeo = new THREE.BoxGeometry(1, 1, 1);
    keepFragmentShaderAlive(scene);

    return (killerDirection?: THREE.Vector3) => {
        const position = cfg.getPosition();
        const sourceMesh = cfg.getSourceMesh?.();
        const simplified = activeCount >= cfg.simplifyThreshold;
        const count = simplified ? Math.ceil(cfg.fragmentCount / 2) : cfg.fragmentCount;
        const dur = simplified ? cfg.duration * 0.6 : cfg.duration;

        let colors = sourceMesh ? extractMeshColors(sourceMesh) : [];
        if (colors.length === 0) colors = [new THREE.Color(0x888888)];

        const fragments: Array<{
            mesh: THREE.Mesh;
            material: THREE.MeshBasicMaterial;
            /** Colour the death flash resolves to — the sampled source colour, untinted. */
            flashTo: THREE.Color;
            velocity: THREE.Vector3;
            spin: THREE.Vector3;
        }> = [];
        const fragSize = cfg.fragmentScale * 0.3;

        for (let i = 0; i < count; i++) {
            const sourceColor = colors[i % colors.length]!;
            const color = sourceColor.clone();
            if (cfg.variant === 'ice') color.lerp(ICE_TINT, 0.5);

            const mat = new THREE.MeshBasicMaterial({
                color: cfg.deathFlash ? 0xffffff : color,
                transparent: true,
                opacity: 1.0,
            });

            const frag = new THREE.Mesh(sharedGeo, mat);
            frag.scale.setScalar(fragSize * (0.6 + Math.random() * 0.8));
            frag.position.copy(position);
            frag.position.y += 0.5;
            frag.position.x += (Math.random() - 0.5) * 0.3;
            frag.position.y += (Math.random() - 0.5) * 0.3;
            frag.position.z += (Math.random() - 0.5) * 0.3;
            frag.rotation.set(
                Math.random() * Math.PI * 2,
                Math.random() * Math.PI * 2,
                Math.random() * Math.PI * 2,
            );

            const baseDir = killerDirection
                ? killerDirection.clone().normalize().multiplyScalar(0.3)
                : new THREE.Vector3(0, 0, 0);
            const randDir = new THREE.Vector3(
                (Math.random() - 0.5) * 2,
                Math.random() * 1.5 + 0.5,
                (Math.random() - 0.5) * 2,
            ).normalize();

            const speed = cfg.scatterRadius * (2 + Math.random() * 3);
            const vel = baseDir.add(randDir.multiplyScalar(speed));
            if (cfg.variant === 'ice') vel.multiplyScalar(0.6);
            else if (cfg.variant === 'explosion') vel.multiplyScalar(1.5);

            scene.add(frag);
            fragments.push({
                mesh: frag,
                material: mat,
                flashTo: sourceColor,
                velocity: vel,
                spin: new THREE.Vector3(
                    (Math.random() - 0.5) * 10,
                    (Math.random() - 0.5) * 10,
                    (Math.random() - 0.5) * 10,
                ),
            });
        }

        activeCount++;
        const startTime = performance.now();
        let prevTime = startTime;

        const animate = (now: number) => {
            const dt = Math.min((now - prevTime) / 1000, 0.05); // cap at 50ms to prevent tunneling
            prevTime = now;
            const elapsed = now - startTime;
            const progress = elapsed / dur;

            if (progress >= 1) {
                for (const { mesh, material } of fragments) {
                    scene.remove(mesh);
                    material.dispose();
                }
                activeCount--;
                return;
            }

            for (const { mesh, material, flashTo, velocity, spin } of fragments) {
                velocity.y -= 9.81 * dt;
                mesh.position.addScaledVector(velocity, dt);
                mesh.rotation.x += spin.x * dt;
                mesh.rotation.y += spin.y * dt;
                mesh.rotation.z += spin.z * dt;

                // Flash: white → real color in first 15%
                if (cfg.deathFlash && progress < 0.15) {
                    const t = progress / 0.15;
                    material.color.setRGB(
                        1 + (flashTo.r - 1) * t,
                        1 + (flashTo.g - 1) * t,
                        1 + (flashTo.b - 1) * t,
                    );
                }

                // Fade in last 33%
                if (progress > 0.67) {
                    material.opacity = 1 - (progress - 0.67) / 0.33;
                }
            }

            requestAnimationFrame(animate);
        };

        requestAnimationFrame(animate);
    };
}

// ── Damage Visual System ───────────────────────────────────────────────

export interface DamageVisualConfig {
    /** HP thresholds for visual stages (default: [0.75, 0.5, 0.25]) */
    thresholds?: [number, number, number];
    /** Enable damage tint — darkens and reddens the mesh as HP drops (default: true) */
    damageTint?: boolean;
    /** Max tint strength 0-1 — how dark/red at lowest HP (default: 0.5) */
    maxTintStrength?: number;
    /** Enable mesh jitter at low HP (default: true) */
    jitter?: boolean;
    /** Enable chip-off fragments at threshold crossings (default: true) */
    chipOff?: boolean;
}

export interface DamageVisualController {
    /** Call each frame with current HP ratio (0-1) */
    update(hpRatio: number, deltaTime: number): void;
    /** Clean up all visual modifications and restore originals */
    dispose(): void;
}

const DEFAULT_DAMAGE_VISUAL: Required<DamageVisualConfig> = {
    thresholds: [0.75, 0.5, 0.25],
    damageTint: true,
    maxTintStrength: 0.5,
    jitter: true,
    chipOff: true,
};

interface StoredColor {
    colorRef: THREE.Color;
    originalColor: THREE.Color;
}

/**
 * Create a progressive damage visual system for a mesh.
 *
 * Applies desaturation, mesh jitter, and chip-off fragments as HP decreases
 * through configured thresholds. Best suited for voxel-style characters
 * whose child mesh positions are static (not skeletal-animated).
 */
export function createDamageVisualSystem(
    scene: THREE.Scene,
    targetMesh: THREE.Object3D,
    config?: DamageVisualConfig
): DamageVisualController {
    const cfg = { ...DEFAULT_DAMAGE_VISUAL, ...config };
    const stored: StoredColor[] = [];
    const chipFragments: THREE.Mesh[] = [];
    const origPositions = new Map<THREE.Object3D, THREE.Vector3>();
    const origRotationZ = targetMesh.rotation.z;
    const sharedChipGeo = new THREE.BoxGeometry(1, 1, 1);
    keepFragmentShaderAlive(scene);
    let jitterTime = 0;
    let prevStage = 0;
    let particleTimer = 0;
    let disposed = false;

    // Clone materials so we can safely mutate colors without affecting shared instances.
    // Track original materials for disposal on cleanup.
    const clonedMaterials: THREE.Material[] = [];
    targetMesh.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.material) return;
        if (Array.isArray(child.material)) {
            child.material = child.material.map((mat: THREE.Material) => {
                const cloned = mat.clone();
                // clone() copies userData — drop the shared-cache flag so the
                // per-NPC clone is disposed normally (cache-owned originals are
                // never mutated or disposed here).
                delete cloned.userData.__sharedLodCache;
                clonedMaterials.push(cloned);
                return cloned;
            });
        } else {
            child.material = child.material.clone();
            delete child.material.userData.__sharedLodCache;
            clonedMaterials.push(child.material);
        }
    });

    // Collect colors from the cloned materials (now safe to mutate)
    const seenColors = new Set<THREE.Color>();
    targetMesh.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.material) return;
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const mat of mats) {
            // Structural, not instanceof — same reasoning as extractMeshColors.
            const colour = (mat as { color?: unknown }).color;
            if (colour instanceof THREE.Color && !seenColors.has(colour)) {
                seenColors.add(colour);
                stored.push({ colorRef: colour, originalColor: colour.clone() });
            }
        }
    });

    // Sample vertex colors from geometry for chip fragments (material.color is often
    // white on textured or vertex-colored meshes, so we need the actual visual colors)
    const chipColors: THREE.Color[] = [];
    targetMesh.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.geometry) return;
        const colorAttr = child.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
        if (colorAttr) {
            // Sample a few random vertex colors
            const count = colorAttr.count;
            for (let i = 0; i < Math.min(8, count); i++) {
                const idx = Math.floor(Math.random() * count);
                chipColors.push(new THREE.Color(
                    colorAttr.getX(idx),
                    colorAttr.getY(idx),
                    colorAttr.getZ(idx),
                ));
            }
        }
    });
    // Fall back to material colors if no vertex colors found
    if (chipColors.length === 0) {
        for (const s of stored) chipColors.push(s.originalColor.clone());
    }

    // Save child mesh positions for jitter
    targetMesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            origPositions.set(child, child.position.clone());
        }
    });

    function getStage(hpRatio: number): number {
        if (hpRatio > cfg.thresholds[0]) return 0;
        if (hpRatio > cfg.thresholds[1]) return 1;
        if (hpRatio > cfg.thresholds[2]) return 2;
        return 3;
    }

    /** Undo jitter — put every child mesh and the lean rotation back where they started */
    function restoreOriginalTransforms(): void {
        targetMesh.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return;
            const orig = origPositions.get(child);
            if (orig) child.position.copy(orig);
        });
        targetMesh.rotation.z = origRotationZ;
    }

    function spawnChip(): void {
        if (chipColors.length === 0 || disposed) return;
        const chipColor = chipColors[Math.floor(Math.random() * chipColors.length)]!;
        const size = 0.06 + Math.random() * 0.06;
        const mat = new THREE.MeshBasicMaterial({
            color: chipColor.clone(),
            transparent: true,
            opacity: 0.9,
        });
        const chip = new THREE.Mesh(sharedChipGeo, mat);
        chip.scale.setScalar(size);
        const worldPos = new THREE.Vector3();
        targetMesh.getWorldPosition(worldPos);
        chip.position.copy(worldPos);
        chip.position.y += 0.3 + Math.random() * 0.8;
        chip.position.x += (Math.random() - 0.5) * 0.5;
        chip.position.z += (Math.random() - 0.5) * 0.5;
        scene.add(chip);
        chipFragments.push(chip);

        const vel = new THREE.Vector3(
            (Math.random() - 0.5) * 2,
            Math.random() * 1.5 + 0.5,
            (Math.random() - 0.5) * 2,
        );
        const chipDur = 800 + Math.random() * 400;
        let chipPrevTime = performance.now();
        const chipStartTime = chipPrevTime;

        const anim = (now: number) => {
            const dt = Math.min((now - chipPrevTime) / 1000, 0.05);
            chipPrevTime = now;
            const p = (now - chipStartTime) / chipDur;
            if (p >= 1 || disposed) {
                scene.remove(chip);
                mat.dispose();
                const idx = chipFragments.indexOf(chip);
                if (idx >= 0) chipFragments.splice(idx, 1);
                return;
            }
            vel.y -= 9.81 * dt;
            chip.position.addScaledVector(vel, dt);
            chip.rotation.x += 0.1 * dt * 60;
            chip.rotation.z += 0.05 * dt * 60;
            if (p > 0.5) mat.opacity = 0.9 * (1 - (p - 0.5) / 0.5);
            requestAnimationFrame(anim);
        };
        requestAnimationFrame(anim);
    }

    return {
        update(hpRatio: number, deltaTime: number): void {
            if (disposed) return;
            const stage = getStage(hpRatio);

            // Damage tint — lerp material.color toward dark red
            // Works on textured materials since color multiplies with the texture
            if (cfg.damageTint) {
                if (stage > 0) {
                    const t = (stage / 3) * cfg.maxTintStrength;
                    for (const s of stored) {
                        // Lerp from original color toward dark red (0.6, 0.2, 0.2)
                        s.colorRef.set(
                            s.originalColor.r + (0.6 - s.originalColor.r) * t,
                            s.originalColor.g + (0.2 - s.originalColor.g) * t,
                            s.originalColor.b + (0.2 - s.originalColor.b) * t,
                        );
                    }
                } else if (prevStage > 0) {
                    for (const s of stored) s.colorRef.copy(s.originalColor);
                }
            }

            // Jitter + lean
            if (cfg.jitter) {
                if (stage > 0) {
                    jitterTime += deltaTime;
                    const intensity = stage * 0.008;
                    targetMesh.traverse((child) => {
                        if (!(child instanceof THREE.Mesh)) return;
                        const orig = origPositions.get(child);
                        if (!orig) return;
                        child.position.set(
                            orig.x + Math.sin(jitterTime * 20 + child.id) * intensity,
                            orig.y + Math.cos(jitterTime * 25 + child.id * 2) * intensity,
                            orig.z + Math.sin(jitterTime * 18 + child.id * 3) * intensity,
                        );
                    });
                    if (stage >= 3) {
                        targetMesh.rotation.z = origRotationZ + Math.sin(jitterTime * 2) * 0.04;
                    }
                } else if (prevStage > 0) {
                    restoreOriginalTransforms();
                }
            }

            // Chip-off at threshold crossings
            if (cfg.chipOff && stage > prevStage) {
                for (let i = 0; i < stage; i++) spawnChip();
            }

            // Constant chips at critical HP
            if (cfg.chipOff && stage >= 3) {
                particleTimer += deltaTime;
                if (particleTimer > 0.5) {
                    particleTimer = 0;
                    spawnChip();
                }
            }

            prevStage = stage;
        },

        dispose(): void {
            if (disposed) return;
            disposed = true;

            restoreOriginalTransforms();

            // Dispose cloned materials
            for (const mat of clonedMaterials) mat.dispose();

            // Clean up chip fragments (rAF callbacks check `disposed` and self-cleanup)
            for (const chip of chipFragments) {
                scene.remove(chip);
                (chip.material as THREE.Material).dispose();
            }
            chipFragments.length = 0;
            origPositions.clear();
            sharedChipGeo.dispose();
        },
    };
}
