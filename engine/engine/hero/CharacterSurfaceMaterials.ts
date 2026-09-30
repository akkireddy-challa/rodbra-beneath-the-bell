import * as THREE from 'three';
import { MeshPhysicalNodeMaterial, PhysicalLightingModel } from 'three/webgpu';
import type { LightingModelDirectInput, Node, NodeBuilder } from 'three/webgpu';
import { BRDF_GGX, DFGLUT, mix, cameraWorldMatrix, pmremTexture, materialEnvIntensity, materialIOR, materialMetalness, materialSpecularColor, materialSpecularIntensity, anisotropyT, anisotropyB, attribute, diffuseColor, float, normalView, positionViewDirection, roughness, specularColor, uniform, vec3 } from 'three/tsl';
import { ShaderChunk } from 'three/src/renderers/shaders/ShaderChunk.js';
import { isWebGpuActive } from 'engine/RendererType.js';

import { skinTransmissionNode, SKIN_TRANSMISSION_GLSL } from 'engine/hero/SkinTransmission.js';
import type { SkinTransmissionPass } from 'engine/hero/SkinTransmissionPass.js';
import { SkinAppearanceState } from 'engine/hero/SkinAppearanceState.js';
import { configureSkinAtlasDetail, copySkinAtlasBinding, skinAtlasCoverageNode, type FacialDetailTextures } from 'engine/hero/SkinAtlasDetail.js';
import { configureSkinMicroDetail } from 'engine/hero/SkinMicroDetail.js';


type Vec3 = Node<'vec3'>;
const SCATTER_COLOR = new THREE.Color(1, 0.55, 0.32);

/** Local diffuse transport approximation. This is not screen-space diffusion. */
class CharacterSkinLighting extends PhysicalLightingModel {
    constructor(material: MeshPhysicalNodeMaterial, private readonly transmissionPass?: SkinTransmissionPass) {
        super(material.useClearcoat, material.useSheen, material.useIridescence, material.useAnisotropy, material.useTransmission, material.useDispersion);
    }

    private coverage(builder: NodeBuilder): Node<'float'> {
        const material = builder.material;
        return material?.userData.skinSurfaceBlend === true ? skinAtlasCoverageNode(material) : float(1);
    }

    override direct(input: LightingModelDirectInput, builder: NodeBuilder): void {
        super.direct(input, builder);
        const light = input.lightDirection as Vec3;
        const color = input.lightColor as Vec3;
        const nl = normalView.dot(light);
        const surfaceWeight = this.coverage(builder);
        if (this.transmissionPass) {
            (input.reflectedLight.directDiffuse as Vec3).addAssign(color.mul(diffuseColor.rgb).mul(skinTransmissionNode(this.transmissionPass, light)).mul(surfaceWeight));
        } else {
        const wrapped = nl.add(0.18).max(0).div(1.18 * 1.18);
        const redistributed = wrapped.sub(nl.max(0)).mul(0.25 / Math.PI);
        const thin = attribute('_scatter', 'float') as unknown as Node<'float'>;
        const transmitted = positionViewDirection.dot(light.negate()).saturate().pow(4)
            .mul(nl.negate().max(0)).mul(thin).mul(0.16);
        const scatterTint = uniform(SCATTER_COLOR) as unknown as Vec3;
        (input.reflectedLight.directDiffuse as Vec3).addAssign(
            color.mul(diffuseColor.rgb).mul(scatterTint.mul(transmitted).add(redistributed)).mul(surfaceWeight),
        );
        }
        // The same two GGX lobes are used for direct and environment reflection.
        const broad = BRDF_GGX({ lightDirection: light, f0: specularColor, f90: float(1), roughness }) as unknown as Vec3;
        const tight = BRDF_GGX({ lightDirection: light, f0: specularColor, f90: float(1), roughness: roughness.mul(0.58).max(0.22) }) as unknown as Vec3;
        const dotNV = normalView.dot(positionViewDirection).saturate();
        const compensation = (r: Node<'float'>) => {
            const fg = DFGLUT({ roughness: r, dotNV }) as unknown as Node<'vec2'>;
            return specularColor.mul(fg.x.add(fg.y).reciprocal().sub(1)).add(1);
        };
        (input.reflectedLight.directSpecular as Vec3).addAssign(color.mul(nl.max(0)).mul(
            tight.mul(compensation(roughness.mul(.58).max(.22))).sub(broad.mul(compensation(roughness))),
        ).mul(.18).mul(surfaceWeight));
    }
    override indirectSpecular(builder: NodeBuilder): void {
        super.indirectSpecular(builder);
        const material = builder.material;
        if (!(material instanceof MeshPhysicalNodeMaterial) || !material.envMap) return;
        const tight = roughness.mul(.58).max(.22);
        const reflected = positionViewDirection.negate().reflect(normalView);
        const direction = mix(reflected, normalView, tight.pow(4)).normalize().transformDirection(cameraWorldMatrix);
        const radianceT = pmremTexture(material.envMap, direction, tight).rgb.mul(materialEnvIntensity);
        const terms = (r: Node<'float'>) => {
            const fg = DFGLUT({ roughness: r, dotNV: normalView.dot(positionViewDirection).saturate() }) as unknown as Node<'vec2'>;
            const single = specularColor.mul(fg.x).add(fg.y);
            const missing = fg.x.add(fg.y).oneMinus();
            const average = (specularColor as unknown as Vec3).add((specularColor as unknown as Vec3).oneMinus().mul(.047619));
            const multi = single.mul(average).mul(missing).div(missing.mul(average).oneMinus());
            return { single, multi };
        };
        const broad = terms(roughness), narrow = terms(tight), surfaceWeight = this.coverage(builder);
        const context = builder.context as { radiance: Vec3; iblIrradiance: Vec3; reflectedLight: { indirectSpecular: Vec3; indirectDiffuse: Vec3 } };
        const irradiance = (context.iblIrradiance as Vec3).mul(1 / Math.PI);
        (context.reflectedLight.indirectSpecular as Vec3).addAssign(radianceT.mul(narrow.single)
            .sub((context.radiance as Vec3).mul(broad.single)).add(irradiance.mul(narrow.multi.sub(broad.multi))).mul(.18).mul(surfaceWeight));
        (context.reflectedLight.indirectDiffuse as Vec3).addAssign(irradiance.mul(diffuseColor.rgb)
            .mul(broad.single.add(broad.multi).sub(narrow.single).sub(narrow.multi)).mul(.18).mul(surfaceWeight));
    }

}

class CharacterSkinNodeMaterial extends MeshPhysicalNodeMaterial {
    transmissionPass?: SkinTransmissionPass;
    override setupVariants(builder: NodeBuilder): void {
        super.setupVariants(builder);
        if (this.userData.skinSurfaceBlend === true && this.useAnisotropy) {
            // The zero-anisotropy limit must equal isotropic GGX, including when
            // the source normal map tilts the shading normal away from the UV frame.
            const tangent = anisotropyT.sub(normalView.mul(normalView.dot(anisotropyT))).normalize().toVar();
            const handedness = normalView.cross(tangent).dot(anisotropyB).sign().toVar();
            anisotropyB.assign(normalView.cross(tangent).mul(handedness));
            anisotropyT.assign(tangent);
        }
    }
    override setupLightingModel(): PhysicalLightingModel { return new CharacterSkinLighting(this, this.transmissionPass); }
    override copy(source: MeshPhysicalNodeMaterial): this {
        super.copy(source);
        copySkinAtlasBinding(source, this);
        if (source instanceof CharacterSkinNodeMaterial) this.transmissionPass = source.transmissionPass;
        return this;
    }
}

function configureWebGlSkin(material: THREE.MeshPhysicalMaterial, transmission?: SkinTransmissionPass): void {
    material.onBeforeCompile = shader => {
        shader.uniforms.characterScatterColor = { value: SCATTER_COLOR };
        shader.fragmentShader = 'float characterSkinSurfaceWeight=1.0;\n' + shader.fragmentShader;
        shader.vertexShader = 'attribute float _scatter; varying float vCharacterScatter;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvCharacterScatter = _scatter;');
        shader.fragmentShader = 'uniform vec3 characterScatterColor; varying float vCharacterScatter;\n' + shader.fragmentShader;
        const direct = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
        if (transmission) {
            Object.assign(shader.uniforms, {
                skinLightMatrix: { value: transmission.matrix }, skinEntryDepth: { value: transmission.target.depthTexture },
                skinEntryMask: { value: transmission.target.texture }, skinKeyDirection: { value: transmission.direction },
                skinDepthRange: { get value() { return transmission.camera.far - transmission.camera.near; } },
                skinTransmissionEnabled: { get value() { return transmission.enabled ? 1 : 0; } },
            });
            shader.vertexShader = 'varying vec3 vSkinWorldPosition;\n' + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nvSkinWorldPosition=(modelMatrix*vec4(transformed,1.)).xyz;');
            shader.fragmentShader = SKIN_TRANSMISSION_GLSL + shader.fragmentShader;
        }
        const transport = transmission ? '{reflectedLight.directDiffuse+=directLight.color*diffuseColor.rgb*skinTransmission(directLight.direction,nonPerturbedNormal)*characterSkinSurfaceWeight;}' : `{
            float skinNL = dot(geometryNormal, directLight.direction);
            float skinWrap = max(skinNL + 0.18, 0.0) / (1.18 * 1.18);
            float skinDiffuse = (skinWrap - max(skinNL, 0.0)) * (0.25 / PI);
            float skinThin = pow(clamp(dot(geometryViewDir, -directLight.direction), 0.0, 1.0), 4.0)
                * max(-skinNL, 0.0) * vCharacterScatter * 0.16;
            reflectedLight.directDiffuse += directLight.color * diffuseColor.rgb
                * (vec3(skinDiffuse) + characterScatterColor * skinThin)*characterSkinSurfaceWeight;
        }`;
        if (!ShaderChunk.lights_fragment_begin.includes(direct)) throw new Error('Character skin light adapter requires an update');
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_fragment_begin>', ShaderChunk.lights_fragment_begin.split(direct).join(direct + transport));
        const lobe = 'vec3 specularBRDF = BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );';
        if (!ShaderChunk.lights_physical_pars_fragment.includes(lobe)) throw new Error('Character skin specular adapter requires an update');
        const dual = `${lobe}
            PhysicalMaterial tightSkin = material;
            tightSkin.roughness = max(material.roughness * 0.58, 0.22);
            #ifdef USE_ANISOTROPY
            tightSkin.alphaT=mix(pow2(tightSkin.roughness),1.,pow2(tightSkin.anisotropy));
            #endif
            vec2 tightDFG=texture2D(dfgLUT,vec2(tightSkin.roughness,saturate(dot(geometryNormal,geometryViewDir)))).rg;
            vec3 tightComp=1.+material.specularColor*(1./(tightDFG.x+tightDFG.y)-1.);
            specularBRDF = mix(specularBRDF, BRDF_GGX(directLight.direction, geometryViewDir, geometryNormal, tightSkin)*tightComp/material.multiScatteringCompensation, 0.18*characterSkinSurfaceWeight);`;
        shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', ShaderChunk.lights_physical_pars_fragment.replace(lobe, dual).replace('vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance;', `vec3 indirectDiffuse = diffuse * cosineWeightedIrradiance;
#ifdef USE_ENVMAP
float skinR=max(material.roughness*.58,.22);
vec2 skinFG=texture2D(dfgLUT,vec2(skinR,saturate(dot(geometryNormal,geometryViewDir)))).rg;
vec3 skinSingle=vec3(0.),skinMulti=vec3(0.);
computeMultiscattering(skinFG,material.specularColor,material.specularF90,skinSingle,skinMulti);
vec3 skinRadiance=getIBLRadiance(geometryViewDir,geometryNormal,skinR);
indirectSpecular=mix(indirectSpecular,skinRadiance*skinSingle+skinMulti*cosineWeightedIrradiance,.18*characterSkinSurfaceWeight);
indirectDiffuse=mix(indirectDiffuse,material.diffuseContribution*(1.-skinSingle-skinMulti)*cosineWeightedIrradiance,.18*characterSkinSurfaceWeight);
#endif
`));
    };
    material.customProgramCacheKey = () => 'character-skin-surface-v1';
}

/** Apply authored material tags and optional UV coverage; never infer anatomy. */
export function createCharacterSurfaceMaterial(source: THREE.Material, atlas?: THREE.Texture, transmission?: SkinTransmissionPass, expressionAtlas?: THREE.Texture, appearance = new SkinAppearanceState(), facial?: FacialDetailTextures): THREE.Material {
    const kind: unknown = source.userData.characterSurface;
    if (kind !== 'skin' && kind !== 'hair' && kind !== 'fur') return source;
    if (!(source instanceof THREE.MeshStandardMaterial)) throw new Error('Character surfaces require a PBR source material');
    const material = isWebGpuActive()
        ? (kind === 'skin' ? new CharacterSkinNodeMaterial() : new MeshPhysicalNodeMaterial())
        : new THREE.MeshPhysicalMaterial();
    const mixed = source.userData.skinSurfaceBlend === true;
    if (mixed && source instanceof THREE.MeshPhysicalMaterial) THREE.MeshPhysicalMaterial.prototype.copy.call(material, source);
    else THREE.MeshStandardMaterial.prototype.copy.call(material, source);
    // StandardMaterial.copy resets defines, including PHYSICAL. Restore it so WebGL
    // actually uses the authored IOR/specular parameters on the physical material.
    if (material instanceof THREE.MeshPhysicalMaterial) material.defines = { ...material.defines, PHYSICAL: '' };
    material.name = source.name;
    if (!mixed) {
        material.metalness = 0;
        material.ior = kind === 'skin' ? 1.4 : 1.55;
        material.specularIntensity = kind === 'skin' ? 0.65 : 0.5;
        material.specularColor.setRGB(1, 1, 1);
        material.clearcoat = 0;
    }
    if (kind === 'skin' && material instanceof THREE.MeshPhysicalMaterial) configureWebGlSkin(material, transmission);
    if (material instanceof CharacterSkinNodeMaterial) material.transmissionPass = transmission;
    if (kind === 'hair' || kind === 'fur') {
        if (!(source instanceof THREE.MeshPhysicalMaterial)) throw new Error('Hair surfaces require authored anisotropy');
        material.anisotropy = source.anisotropy;
        material.anisotropyMap = source.anisotropyMap;
        material.anisotropyRotation = source.anisotropyRotation;
        material.sheen = 1;
        material.sheenColor.copy(source.sheenColor);
        material.sheenRoughness = 0.8;
    }
    if (kind === 'skin' && (source.userData.skinMicroDetail === true || mixed)) {
        if (atlas && expressionAtlas) configureSkinAtlasDetail(material, atlas, source.userData.skinMicroDetail === true ? Number(source.userData.skinAtlasHeightRangeM) : 0, expressionAtlas, appearance, facial);
        else if (atlas) throw new Error('Registered skin atlas is missing its expression map');
        else configureSkinMicroDetail(material);
    }
    if (mixed) {
        if (material instanceof MeshPhysicalNodeMaterial) {
            const coverage = skinAtlasCoverageNode(material);
            material.metalnessNode = materialMetalness.mul(coverage.oneMinus());
            material.iorNode = mix(materialIOR, float(1.4), coverage);
            material.specularIntensityNode = mix(materialSpecularIntensity, float(.65), coverage);
            material.specularColorNode = mix(materialSpecularColor, vec3(1), coverage);
        } else {
            const previous = material.onBeforeCompile;
            material.onBeforeCompile = (shader, renderer) => {
                previous(shader, renderer);
                for (const marker of ['material.ior = ior;', 'material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );']) {
                    if (!ShaderChunk.lights_physical_fragment.includes(marker)) throw new Error(`Skin material shader contract changed: ${marker}`);
                }
                shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor*=1.-skinCoverage;');
                const physical = ShaderChunk.lights_physical_fragment
                    .replace('material.ior = ior;', 'material.ior=mix(ior,1.4,skinCoverage);')
                    .replace('material.specularF90 = mix( specularIntensityFactor, 1.0, metalnessFactor );', `
                        specularIntensityFactor=mix(specularIntensityFactor,.65,skinCoverage);
                        specularColorFactor=mix(specularColorFactor,vec3(1.),skinCoverage);
                        #ifdef CHARACTER_SKIN_DIFFUSE_PASS
                        specularIntensityFactor=0.;
                        #endif
                        material.specularF90=mix(specularIntensityFactor,1.,metalnessFactor);`);
                shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_fragment>', physical + `
                    #ifdef USE_ANISOTROPY
                    vec3 skinFrameT=normalize(material.anisotropyT-normal*dot(normal,material.anisotropyT));
                    float skinFrameHandedness=sign(dot(cross(normal,skinFrameT),material.anisotropyB));
                    material.anisotropyT=skinFrameT;
                    material.anisotropyB=cross(normal,skinFrameT)*skinFrameHandedness;
                    #endif
                `);
            };
            material.customProgramCacheKey = () => 'character-mixed-skin-v1';
        }
    }
    return material;
}
