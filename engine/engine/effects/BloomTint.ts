import * as THREE from 'three';

/**
 * `userData` key holding the exact emissive hex the bloom tint last wrote onto
 * a material. It is what makes the tint removable WITHOUT guessing: a cleanup
 * pass clears the emissive only when the material still carries the value this
 * function put there, so authored emission — a glowing part, or a character
 * whose whole appearance is stored on the emissive channel — survives.
 */
const BLOOM_TINT_HEX = 'bloomTintEmissiveHex';

function isBlack(colour: THREE.Color): boolean {
    return colour.r === 0 && colour.g === 0 && colour.b === 0;
}

/**
 * True when `material`'s current emissive is exactly the tint this module
 * wrote (and nothing has overwritten it since).
 */
function carriesBloomTint(material: THREE.Material): boolean {
    const m = material as THREE.MeshStandardMaterial;
    const written = m.userData?.[BLOOM_TINT_HEX];
    if (typeof written !== 'number') return false;
    return m.emissive instanceof THREE.Color && m.emissive.getHex() === written;
}

/**
 * Give an object a low-level emissive tint so it self-illuminates and stands
 * out under the scene's full-scene bloom (the bright emissive pixels exceed
 * the bloom threshold and pick up a soft halo). Cheaper and more
 * art-directable than running selective bloom as a separate post pass, and
 * identical on WebGL and WebGPU.
 *
 * The emissive value is intentionally small (a fraction of the diffuse
 * color) so the object looks roughly the same when bloom is disabled.
 *
 * AUTHORED EMISSION IS NEVER OVERWRITTEN: a material with an `emissiveMap`, or
 * one whose emissive is already non-black for any reason other than a previous
 * tint of ours, is left exactly as its author made it. Some GLB characters
 * carry their entire look (clothing, face) as an emissive texture; tinting
 * those would replace the texture's tint and hand the cleanup pass something it
 * would then erase.
 *
 * Games call this through `GameEngine.enableBloomOnObject()`.
 */
export function applyBloomTint(object: THREE.Object3D): void {
    object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        // Meshes can opt out of the emissive bloom tint (e.g. realistic
        // skinned player meshes, where the grey self-glow reads as a milky wash).
        if (mesh.userData.skipBloomTint) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of materials) {
            const m = mat as THREE.MeshStandardMaterial;
            if (!m || !(m.emissive instanceof THREE.Color)) continue;
            if (m.emissiveMap) continue;
            if (!isBlack(m.emissive) && !carriesBloomTint(m)) continue;
            // Mix toward the diffuse color (when available) at low intensity;
            // fall back to a soft warm tint for materials without a base color.
            if (m.color instanceof THREE.Color) {
                m.emissive.copy(m.color).multiplyScalar(0.35);
            } else {
                m.emissive.setRGB(0.15, 0.15, 0.12);
            }
            if (typeof m.emissiveIntensity === 'number') {
                m.emissiveIntensity = Math.max(m.emissiveIntensity, 1.0);
            }
            m.userData[BLOOM_TINT_HEX] = m.emissive.getHex();
            m.needsUpdate = true;
        }
    });
}

/**
 * Undo `applyBloomTint` on one material — and ONLY that. A material this module
 * never tinted, or whose emissive has since been written by something else
 * (a DamageFlash red, an authored glow), is left untouched. Returns true when
 * a tint was actually cleared.
 */
export function clearBloomTint(material: THREE.Material): boolean {
    if (!carriesBloomTint(material)) return false;
    const m = material as THREE.MeshStandardMaterial;
    m.emissive.setRGB(0, 0, 0);
    delete m.userData[BLOOM_TINT_HEX];
    m.needsUpdate = true;
    return true;
}
