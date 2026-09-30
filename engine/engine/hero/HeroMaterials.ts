import * as THREE from 'three';
import { MeshPhysicalNodeMaterial, PhysicalLightingModel } from 'three/webgpu';
import type { LightingModelDirectInput, Node, NodeBuilder } from 'three/webgpu';
import { normalView, positionViewDirection, uniform } from 'three/tsl';
import { ShaderChunk } from 'three/src/renderers/shaders/ShaderChunk.js';
import { isWebGpuActive } from 'engine/RendererType.js';
import type { HeroSurface } from 'engine/hero/HeroCharacterDefinition.js';

type Vec3 = Node<'vec3'>;

class HeroSkinLighting extends PhysicalLightingModel {
    constructor(private readonly tint: Vec3) { super(false, false, false, false, false, false); }

    override direct(input: LightingModelDirectInput, builder: NodeBuilder): void {
        super.direct(input, builder);
        const bent = (input.lightDirection as Vec3).add(normalView.mul(0.25)).normalize();
        const backscatter = positionViewDirection.dot(bent.negate()).saturate().pow(3);
        (input.reflectedLight.directDiffuse as Vec3).addAssign(backscatter.mul(this.tint).mul(input.lightColor as Vec3));
    }
}

class HeroSkinNodeMaterial extends MeshPhysicalNodeMaterial {
    scatterTint: Vec3 | null = null;
    override setupLightingModel(): PhysicalLightingModel {
        return this.scatterTint ? new HeroSkinLighting(this.scatterTint) : super.setupLightingModel();
    }
}

/** Preserve authored texture/UV inputs. Surface classification never uses color heuristics. */
export function createHeroMaterial(source: THREE.MeshStandardMaterial, surface: HeroSurface): THREE.Material {
    const tint = new THREE.Color(surface.scatter.color).multiplyScalar(surface.scatter.strength);
    let material: THREE.MeshPhysicalMaterial | MeshPhysicalNodeMaterial;
    if (isWebGpuActive()) {
        const node = new HeroSkinNodeMaterial();
        if (surface.kind === 'skin') node.scatterTint = uniform(tint) as unknown as Vec3;
        material = node;
    } else {
        material = new THREE.MeshPhysicalMaterial();
        if (surface.kind === 'skin') {
            material.onBeforeCompile = shader => {
                shader.uniforms.heroScatterTint = { value: tint };
                shader.fragmentShader = `uniform vec3 heroScatterTint;\n${shader.fragmentShader}`;
                const direct = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
                const scatter = `
                    reflectedLight.directDiffuse += directLight.color * heroScatterTint *
                        pow(clamp(dot(geometryViewDir, -normalize(directLight.direction + geometryNormal * 0.25)), 0.0, 1.0), 3.0);
                `;
                const chunk = ShaderChunk.lights_fragment_begin;
                if (!chunk.includes(direct)) throw new Error('Hero skin shader requires an updated Three.js light adapter');
                shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', chunk.split(direct).join(direct + scatter));
            };
            material.customProgramCacheKey = () => 'hero-skin-v1';
        }
    }
    // MeshStandard.copy carries geometry flags, texture transforms (via shared maps),
    // normal scale, alpha/depth behavior and vertex colors, without physical-only gaps.
    THREE.MeshStandardMaterial.prototype.copy.call(material, source);
    material.roughness = surface.roughness;
    material.specularIntensity = surface.specularIntensity;
    material.metalness = surface.kind === 'metal' ? source.metalness : 0;
    if (surface.kind === 'eye') {
        material.ior = 1.376;
        material.clearcoat = 1;
        material.clearcoatRoughness = 0.03;
    }
    if (surface.kind === 'cloth' || surface.kind === 'fur') {
        material.sheen = surface.kind === 'fur' ? 0.4 : 0.2;
        material.sheenColor.set(0xffffff);
        material.sheenRoughness = 0.8;
    }
    if (surface.kind === 'hair') {
        material.anisotropy = 0.5;
        material.anisotropyRotation = Math.PI / 2;
        material.sheen = 0;
        material.specularColor.set(0x6c5948);
    }
    return material;
}
