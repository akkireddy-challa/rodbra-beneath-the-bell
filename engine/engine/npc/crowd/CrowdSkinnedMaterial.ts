/**
 * CrowdSkinnedMaterial — poses a merged crowd character entirely on the GPU.
 *
 * Each instance carries a FRAME ROW into the baked bone table (CrowdAnimationBake)
 * and each vertex carries a single `boneIndex` (CrowdMeshBake). The vertex shader
 * fetches that bone's matrix for that frame and transforms the vertex — so the
 * CPU does no skeleton evaluation, no `updateMatrixWorld`, and no per-part
 * hierarchy walk. Measured, that CPU path costs ~1.8 ms per NPC per frame, which
 * is what caps crowd size long before triangles or draw calls do.
 *
 * One bone influence per vertex, so there is no weight blending: a block
 * character's boxes each belong to exactly one bone, which is why the merge is
 * lossless and why this shader is a single fetch rather than four.
 *
 * ## Both backends, one bake
 *
 * Per `docs/renderer-backends.md`, both paths live in this factory and are chosen
 * at construction. They share the SAME `Float32Array` from the bake — TSL and
 * GLSL differ only in how they express the fetch, not in what they read. The
 * material is Lambert on both sides so the crowd lights like everything else in
 * the scene rather than being a flat-shaded special case.
 *
 * ## Layout contract (must match CrowdAnimationBake)
 *
 * The bone texture is RGBA-float, one texel per matrix COLUMN, four texels per
 * bone, `boneCount * 4` texels wide, one image row per animation frame. Matrices
 * are stored column-major (`Matrix4.toArray`), so four consecutive texels are
 * the four columns and `mat4(c0, c1, c2, c3)` reconstructs it directly.
 */
import * as THREE from 'three';
import { MeshLambertNodeMaterial } from 'three/webgpu';
import { attribute, texture, float, vec2, vec3, vec4, mat3, mat4, positionGeometry, normalGeometry, sin, cos } from 'three/tsl';
import { isWebGpuActive } from 'engine/RendererType.js';

/** Per-instance attribute names, shared by both backends and the writer. */
export const CROWD_INSTANCE_FRAME_ATTRIBUTE = 'instanceFrameRow';
export const CROWD_BONE_INDEX_ATTRIBUTE = 'boneIndex';
/**
 * Per-instance placement for the WebGPU path: xyz = world position of the
 * character root, w = uniform scale. Mirrors what CrowdRenderer composes into
 * `instanceMatrix` — see createWebGpuCrowdMaterial for why the TSL shader cannot
 * simply use the instance matrix three applies.
 */
export const CROWD_INSTANCE_XFM_ATTRIBUTE = 'instanceCrowdXfm';
/** Per-instance yaw (radians) for the WebGPU path; crowd characters are upright. */
export const CROWD_INSTANCE_YAW_ATTRIBUTE = 'instanceCrowdYaw';

export interface CrowdSkinnedMaterialOptions {
    /** Packed bone table — see packAnimationTexture. */
    boneTexture: THREE.DataTexture;
    /** Bones per frame row; sets the texel stride. */
    boneCount: number;
    /** Total frame rows in the table (texture height). */
    frameCount: number;
}

/**
 * Build the crowd material for the active backend.
 *
 * Returns a material that expects: a `boneIndex` vertex attribute, an
 * `instanceFrameRow` instanced attribute, and per-instance colour via the
 * standard `instanceColor` that InstancedMesh already supports (palette variation
 * rides on that rather than a bespoke attribute, so it needs no shader of ours).
 */
export function createCrowdSkinnedMaterial(options: CrowdSkinnedMaterialOptions): THREE.Material {
    return isWebGpuActive()
        ? createWebGpuCrowdMaterial(options)
        : createWebGlCrowdMaterial(options);
}

/**
 * WebGL2: a stock Lambert material with the skinning spliced into its vertex
 * stage via onBeforeCompile, so shadows, fog and lighting keep working unchanged.
 * A raw ShaderMaterial would mean reimplementing all of that.
 */
function createWebGlCrowdMaterial(options: CrowdSkinnedMaterialOptions): THREE.Material {
    const { boneTexture, boneCount, frameCount } = options;
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });

    material.onBeforeCompile = (shader) => {
        shader.uniforms.crowdBoneTexture = { value: boneTexture };
        shader.uniforms.crowdBoneCount = { value: boneCount };
        shader.uniforms.crowdFrameCount = { value: frameCount };

        shader.vertexShader = `
            uniform sampler2D crowdBoneTexture;
            uniform float crowdBoneCount;
            uniform float crowdFrameCount;
            attribute float ${CROWD_BONE_INDEX_ATTRIBUTE};
            attribute float ${CROWD_INSTANCE_FRAME_ATTRIBUTE};

            // Fetch one column of this vertex's bone matrix. Texel centres
            // (the +0.5) matter: sampling on the boundary with NEAREST is
            // implementation-defined and shows up as an occasional wrong bone.
            vec4 crowdBoneColumn(float bone, float frame, float column) {
                float x = (bone * 4.0 + column + 0.5) / (crowdBoneCount * 4.0);
                float y = (frame + 0.5) / crowdFrameCount;
                return texture2D(crowdBoneTexture, vec2(x, y));
            }

            mat4 crowdBoneMatrix(float bone, float frame) {
                return mat4(
                    crowdBoneColumn(bone, frame, 0.0),
                    crowdBoneColumn(bone, frame, 1.0),
                    crowdBoneColumn(bone, frame, 2.0),
                    crowdBoneColumn(bone, frame, 3.0)
                );
            }
        ` + shader.vertexShader;

        // Pose BEFORE three's own instancing/model transform runs, so the
        // InstancedMesh matrix still places the posed character in the world.
        shader.vertexShader = shader.vertexShader.replace(
            '#include <begin_vertex>',
            `
            mat4 crowdPose = crowdBoneMatrix(${CROWD_BONE_INDEX_ATTRIBUTE}, ${CROWD_INSTANCE_FRAME_ATTRIBUTE});
            vec3 transformed = (crowdPose * vec4(position, 1.0)).xyz;
            `,
        );
        // Normals must follow the same rotation or the crowd lights inside-out
        // as it turns. Bone matrices are rigid here (no scale in a block
        // character rig), so the upper 3x3 is its own normal matrix.
        shader.vertexShader = shader.vertexShader.replace(
            '#include <beginnormal_vertex>',
            `
            mat4 crowdPoseN = crowdBoneMatrix(${CROWD_BONE_INDEX_ATTRIBUTE}, ${CROWD_INSTANCE_FRAME_ATTRIBUTE});
            vec3 objectNormal = mat3(crowdPoseN) * normal;
            `,
        );
    };

    // onBeforeCompile output is cached by program key; without a distinct key a
    // crowd material can collide with an ordinary Lambert in the program cache.
    material.customProgramCacheKey = () => `crowd-skinned-${boneCount}-${frameCount}`;
    return material;
}

/**
 * WebGPU: the same fetch expressed in TSL on a Lambert node material.
 *
 * ORDER MATTERS, and it differs from the GLSL path. NodeMaterial.setupPosition
 * runs `instancedMesh(object)` — which overwrites `positionLocal` with
 * `instanceMatrix * position` — BEFORE it assigns `positionNode`. A pose built
 * on `positionLocal` therefore rotates a vertex that already sits hundreds of
 * metres from the origin, and every animation frame flings the body across the
 * sky (seen: townsfolk tumbling in the air over Roll City). So the pose is
 * applied to `positionGeometry`, the raw attribute, and the instance placement
 * is re-applied here from two attributes CrowdRenderer writes alongside the
 * matrix: position+scale and yaw. `instanceMatrix` itself stays authoritative
 * for three's frustum culling of the batch; its transform of positionLocal is
 * simply not read.
 */
function createWebGpuCrowdMaterial(options: CrowdSkinnedMaterialOptions): THREE.Material {
    const { boneTexture, boneCount, frameCount } = options;
    const material = new MeshLambertNodeMaterial();
    material.vertexColors = true;

    // Cast to the float-node shape: TSL's attribute() is typed by attribute NAME,
    // not by the value type, so the arithmetic helpers are not visible without it.
    // Same pattern as weather/VehicleWetFX.ts.
    const boneIndex = attribute(CROWD_BONE_INDEX_ATTRIBUTE, 'float') as unknown as ReturnType<typeof float>;
    const frameRow = attribute(CROWD_INSTANCE_FRAME_ATTRIBUTE, 'float') as unknown as ReturnType<typeof float>;
    const xfm = attribute(CROWD_INSTANCE_XFM_ATTRIBUTE, 'vec4') as unknown as ReturnType<typeof vec4>;
    const yaw = attribute(CROWD_INSTANCE_YAW_ATTRIBUTE, 'float') as unknown as ReturnType<typeof float>;
    const texWidth = float(boneCount * 4);
    const texHeight = float(frameCount);
    const boneTex = texture(boneTexture);

    // Same fetch as the GLSL path: four consecutive texels are the four COLUMNS
    // of a column-major Matrix4 (Matrix4.toArray order), so mat4(c0..c3) rebuilds
    // it directly. Texel centres (+0.5) matter — sampling exactly on a boundary
    // with NEAREST is implementation-defined and picks the wrong bone at random.
    const column = (col: number) => {
        const x = boneIndex.mul(4).add(float(col)).add(0.5).div(texWidth);
        const y = frameRow.add(0.5).div(texHeight);
        return boneTex.sample(vec2(x, y));
    };
    const c0 = column(0);
    const c1 = column(1);
    const c2 = column(2);
    const c3 = column(3);

    // Pose in MODEL space from the raw attribute, then place the instance:
    // rotate about Y by yaw (three's rotateY: x' = c·x + s·z, z' = -s·x + c·z),
    // scale uniformly, translate. Same result as instanceMatrix * pose * p.
    const posed = mat4(c0, c1, c2, c3).mul(vec4(positionGeometry, 1.0)).xyz;
    const s = sin(yaw);
    const c = cos(yaw);
    const rotated = vec3(
        posed.x.mul(c).add(posed.z.mul(s)),
        posed.y,
        posed.z.mul(c).sub(posed.x.mul(s)),
    );
    material.positionNode = rotated.mul(xfm.w).add(xfm.xyz);
    // Bone matrices in a voxel/block rig are rigid (no scale), so the upper 3x3
    // doubles as the normal matrix; without this the crowd lights inside-out as
    // it turns. Built from the columns directly because TSL has no mat4 -> mat3
    // truncation. Then the same yaw as the position (uniform scale leaves a
    // normalised normal alone).
    const posedNormal = mat3(c0.xyz, c1.xyz, c2.xyz).mul(normalGeometry);
    material.normalNode = vec3(
        posedNormal.x.mul(c).add(posedNormal.z.mul(s)),
        posedNormal.y,
        posedNormal.z.mul(c).sub(posedNormal.x.mul(s)),
    ).normalize();
    return material;
}
