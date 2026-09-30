import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, type Node } from 'three/webgpu';
import { Fn, mix, attribute, materialColor, materialRoughness, normalMap, normalViewGeometry, positionView, texture, uniform, step, vec2, vec3, vec4 } from 'three/tsl';
import { SkinAppearanceState } from 'engine/hero/SkinAppearanceState.js';

/** Left half: facial detail RGBA; right half: expression RGBA. Replaces the
 * neutral body expression sampler, keeping the mixed material within WebGL limits. */
export interface FacialDetailTextures { atlas: THREE.Texture }
interface AtlasBinding { atlas: THREE.Texture; expression: THREE.Texture; state: SkinAppearanceState; heightRangeM: number; facial: FacialDetailTextures | undefined; regionalHeightStart: number }
const bindings = new WeakMap<THREE.Material, AtlasBinding>();
export function copySkinAtlasBinding(source: THREE.Material, target: THREE.Material): void {
    const binding = bindings.get(source); if (binding) bindings.set(target, binding);
}
function nodes(binding: AtlasBinding) {
    const coords = attribute('_face_uv', 'vec2') as unknown as Node<'vec2'>;
    const front = attribute('_face_weight', 'float') as unknown as Node<'float'>;
    const body = texture(binding.atlas, coords);
    const bodyExpression = binding.facial ? vec4(128 / 255, 128 / 255, 128 / 255, 0) : texture(binding.expression, coords);
    let data: Node<'vec4'> = body, expression: Node<'vec4'> = bodyExpression;
    if (binding.facial) {
        const facialDetail = attribute('_facial_detail', 'vec3') as unknown as Node<'vec3'>;
        const facialUv = facialDetail.xy;
        const packedUv = facialUv.clamp(.0005, .9995).mul(vec2(.5, 1));
        const face = texture(binding.facial.atlas, packedUv), faceExpression = texture(binding.facial.atlas, packedUv.add(vec2(.5, 0)));
        const frontWeight = facialDetail.z;
        const weight = frontWeight.mul(face.a).clamp(0, 1);
        const regional = step(uniform(binding.regionalHeightStart), facialUv.y);
        const patch = vec3(face.r.add(body.r.sub(.5).mul(regional)), face.g, face.b);
        data = vec4(mix(body.rgb, patch, weight), body.a);
        expression = mix(bodyExpression, faceExpression, weight);
    }
    const weights = uniform(binding.state.weights);
    return { data, expression, weights, coverage: body.a.mul(front) };
}

/** A mixed material must retain its authored mask even with relief disabled. */
export function skinAtlasCoverageNode(material: THREE.Material): Node<'float'> {
    const binding = bindings.get(material);
    if (!binding) throw new Error('Mixed skin surface requires an atlas binding');
    return nodes(binding).coverage as Node<'float'>;
}

/** Mask extraction for diffusion alpha or light-entry tissue coverage. */
export function configureSkinCoveragePass(source: THREE.Material, target: THREE.Material, channel: 'alpha' | 'color'): void {
    if (source.userData.skinSurfaceBlend !== true) return;
    const binding = bindings.get(source);
    if (!binding) throw new Error('Mixed skin coverage pass requires an atlas binding');
    if (target instanceof MeshPhysicalNodeMaterial || target instanceof MeshBasicNodeMaterial) {
        const coverage = nodes(binding).coverage;
        if (channel === 'alpha') target.opacityNode = coverage;
        else target.colorNode = vec3(coverage);
    } else {
        const previous = target.onBeforeCompile;
        target.onBeforeCompile = (shader, renderer) => {
            previous(shader, renderer);
            shader.uniforms.skinPassAtlas = { value: binding.atlas };
            const attributes = shader.vertexShader.includes('attribute vec2 _face_uv;') ? '' : 'attribute vec2 _face_uv; attribute float _face_weight; ';
            shader.vertexShader = attributes + 'varying vec3 vSkinPassUv;\n' + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvSkinPassUv=vec3(_face_uv,_face_weight);');
            shader.fragmentShader = 'uniform sampler2D skinPassAtlas; varying vec3 vSkinPassUv;\n' + shader.fragmentShader;
            const mask = 'texture2D(skinPassAtlas,vSkinPassUv.xy).a*vSkinPassUv.z';
            shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n' +
                (channel === 'alpha' ? `gl_FragColor.a=${mask};` : `gl_FragColor.rgb=vec3(${mask});`));
        };
        target.customProgramCacheKey = () => `character-skin-mask-${channel}-v1`;
    }
    if (channel === 'alpha') {
        target.transparent = true;
        target.blending = THREE.NoBlending;
        target.depthWrite = true;
    }
}

/** Also used by the albedo extraction pass: pigment must be identical there. */
export function configureSkinAtlasPigment(source: THREE.Material, target: THREE.Material): void {
    const binding = bindings.get(source); if (!binding) return;
    if (target instanceof MeshPhysicalNodeMaterial || target instanceof MeshBasicNodeMaterial) {
        const { data, expression, weights, coverage } = nodes(binding);
        const vascular = weights.x.max(weights.y).max(weights.z).mul(expression.a).mul(.25);
        const pigment = data.b.sub(.5).mul(2).add(vascular).mul(coverage);
        target.colorNode = (materialColor as unknown as Node<'vec4'>).rgb.mul(vec3(1).add(vec3(.08, -.025, -.035).mul(pigment)));
        return;
    }
    const previous = target.onBeforeCompile;
    target.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        Object.assign(shader.uniforms, { skinAtlas: { value: binding.atlas }, skinExpression: { value: binding.facial?.atlas ?? binding.expression },
            skinAppearance: { value: binding.state.weights }, skinAtlasHeightRange: { value: binding.heightRangeM }, skinRegionalHeightStart: { value: binding.regionalHeightStart } });
        shader.vertexShader = 'attribute vec2 _face_uv; attribute float _face_weight; varying vec2 vFaceUv; varying float vFaceWeight;\n' + shader.vertexShader;
        shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFaceUv=_face_uv;vFaceWeight=_face_weight;');
        shader.fragmentShader = 'uniform sampler2D skinAtlas,skinExpression; uniform vec3 skinAppearance; uniform float skinAtlasHeightRange,skinRegionalHeightStart; varying vec2 vFaceUv; varying float vFaceWeight;\n' + shader.fragmentShader;
        if (binding.facial) {
            shader.vertexShader = 'attribute vec3 _facial_detail; varying vec3 vFacialDetail;\n' + shader.vertexShader;
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacialDetail=_facial_detail;');
            shader.fragmentShader = 'varying vec3 vFacialDetail;\n' + shader.fragmentShader;
        }
        shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
            vec4 skinAtlasData=texture2D(skinAtlas,vFaceUv),skinExpressionData=${binding.facial ? 'vec4(128./255.,128./255.,128./255.,0.)' : 'texture2D(skinExpression,vFaceUv)'};
            float skinCoverage=skinAtlasData.a*vFaceWeight;
            ${binding.facial ? `vec2 facialPackedUv=clamp(vFacialDetail.xy,vec2(.0005),vec2(.9995))*vec2(.5,1.);
            vec4 facialData=texture2D(skinExpression,facialPackedUv);
            float facialWeight=clamp(vFacialDetail.z*facialData.a,0.,1.);
            facialData.r+=(skinAtlasData.r-.5)*step(skinRegionalHeightStart,vFacialDetail.y);
            skinAtlasData.rgb=mix(skinAtlasData.rgb,facialData.rgb,facialWeight);
            skinExpressionData=mix(skinExpressionData,texture2D(skinExpression,facialPackedUv+vec2(.5,0.)),facialWeight);` : ''}
            float skinPigment=((skinAtlasData.b-.5)*2.+max(max(skinAppearance.x,skinAppearance.y),skinAppearance.z)*skinExpressionData.a*.25)*skinCoverage;
            diffuseColor.rgb*=vec3(1.)+vec3(.08,-.025,-.035)*skinPigment;`);
        if (source.userData.skinSurfaceBlend === true && shader.fragmentShader.includes('float characterSkinSurfaceWeight')) {
            shader.fragmentShader = shader.fragmentShader.replace('float skinCoverage=skinAtlasData.a*vFaceWeight;', 'float skinCoverage=skinAtlasData.a*vFaceWeight;\ncharacterSkinSurfaceWeight=skinCoverage;');
        }
    };
    target.customProgramCacheKey = () => `character-skin-pigment-v4-${Boolean(binding.facial)}`;
}

/** R: signed height around .5, G: roughness, B: chromatic residual, A: coverage.
 * Expression RGB contains signed regional height deltas; A is a color-change mask.
 * These are authoring maps, not a measured dynamic scattering model.
 */
export function configureSkinAtlasDetail(material: THREE.MeshPhysicalMaterial | MeshPhysicalNodeMaterial, atlas: THREE.Texture, heightRangeM: number,
    expression: THREE.Texture, state: SkinAppearanceState, facial?: FacialDetailTextures): void {
    // Existing assets retain replacement semantics. Only explicit regional-height
    // assets add their fine relief to underlying body creases; facial detail replaces.
    let regionalHeightStart = 2;
    if (material.userData.skinRegionalAtlasHeightMode !== undefined) {
        const region: unknown = material.userData.skinFacialAtlasRegion;
        if (!facial || material.userData.skinRegionalAtlasHeightMode !== 'additive-v1' || !Array.isArray(region) || region.length !== 4 ||
            region[0] !== 0 || region[1] !== 0 || region[2] !== 1 || typeof region[3] !== 'number' || !Number.isFinite(region[3]) || region[3] <= 0 || region[3] >= 1)
            throw new Error('Additive regional skin detail requires a packed facial atlas with a valid top-row face rectangle');
        regionalHeightStart = region[3];
    }
    const binding = { atlas, expression, heightRangeM, state, facial, regionalHeightStart };
    for (const map of [atlas, expression, ...(facial ? [facial.atlas] : [])]) { map.colorSpace = THREE.NoColorSpace; map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping; }
    bindings.set(material, binding);
    configureSkinAtlasPigment(material, material);
    if (material instanceof MeshPhysicalNodeMaterial) {
        const { data, expression: dynamic, weights, coverage } = nodes(binding);
        const nativeNormal = (material.normalMap ? normalMap(texture(material.normalMap), uniform(material.normalScale)) : normalViewGeometry) as unknown as Node<'vec3'>;
        const base = material.userData.skinSurfaceBlend === true ? mix(nativeNormal, normalViewGeometry, coverage).normalize() : nativeNormal;
        const detailed = Fn(() => {
            const n = (base as unknown as Node<'vec3'>).toVar();
            const dx = positionView.dFdx(), dy = positionView.dFdy();
            const r1 = dy.cross(n), r2 = n.cross(dx), det = dx.dot(r1);
            const height = data.r.sub(.5).add(dynamic.rgb.sub(.5).dot(weights)).mul(heightRangeM).mul(coverage);
            return n.sub(r1.mul(height.dFdx()).add(r2.mul(height.dFdy())).mul(det.sign()).div(det.abs().max(1e-12))).normalize();
        })();
        material.normalNode = detailed;
        const variance = detailed.dFdx().dot(detailed.dFdx()).add(detailed.dFdy().dot(detailed.dFdy())).mul(.25);
        const filtered = mix(materialRoughness, data.g, coverage).pow(2).add(variance).sqrt().clamp(.25, .9);
        material.roughnessNode = (material.userData.skinSurfaceBlend === true ? mix(materialRoughness, filtered, coverage) : filtered) as Node<'float'>;
        return;
    }
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
            ${material.userData.skinSurfaceBlend === true ? 'normal=normalize(mix(normal,nonPerturbedNormal,skinCoverage));\nfloat nativeSurfaceRoughness=roughnessFactor;' : ''}
            float skinHeight=((skinAtlasData.r-.5)+dot(skinExpressionData.rgb-.5,skinAppearance))*skinAtlasHeightRange*skinCoverage;
            vec3 skinDx=dFdx(-vViewPosition),skinDy=dFdy(-vViewPosition);
            vec3 skinR1=cross(skinDy,normal),skinR2=cross(normal,skinDx);
            float skinDet=dot(skinDx,skinR1);
            normal=normalize(normal-(skinR1*dFdx(skinHeight)+skinR2*dFdy(skinHeight))*sign(skinDet)/max(abs(skinDet),1.e-12));
            float skinVariance=.25*(dot(dFdx(normal),dFdx(normal))+dot(dFdy(normal),dFdy(normal)));
            roughnessFactor=clamp(sqrt(pow(mix(roughnessFactor,skinAtlasData.g,skinCoverage),2.)+skinVariance),.25,.9);`);
        if (material.userData.skinSurfaceBlend === true) shader.fragmentShader = shader.fragmentShader.replace(
            'roughnessFactor=clamp(sqrt(pow(mix(roughnessFactor,skinAtlasData.g,skinCoverage),2.)+skinVariance),.25,.9);',
            'roughnessFactor=mix(nativeSurfaceRoughness,clamp(sqrt(pow(mix(roughnessFactor,skinAtlasData.g,skinCoverage),2.)+skinVariance),.25,.9),skinCoverage);');
    };
    material.customProgramCacheKey = () => `character-skin-atlas-v4-${Boolean(facial)}`;
}
