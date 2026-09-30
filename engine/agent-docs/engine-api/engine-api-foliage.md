# engine-api-foliage

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/foliage/FoliageGeometry.ts
function foliagePatch(x: number, z: number): number
function foliageSeed(seed: number, key: string): number
function addFoliageAttributes(geometry: THREE.BufferGeometry, height: number, flexibility = 1): void
function translateFoliage(geometry: THREE.BufferGeometry, x: number, y: number, z: number): void
function createMeadowTuft(rng: SeededRandom, x: number, z: number, groundY: number, heightAt: (x: number, z: number) => number): THREE.BufferGeometry
function createMeadowFlower(rng: SeededRandom): THREE.BufferGeometry
function createBlockBlade(size: number): THREE.BufferGeometry

## engine/foliage/FoliageMaterial.ts
interface FoliageAppearance — Live appearance controls; time=null follows wall time without template update code.
FoliageAppearance.windStrength: number
FoliageAppearance.windSpeed: number
FoliageAppearance.windDirectionDeg: number
FoliageAppearance.time: number | null
FoliageAppearance.debug: 'final' | 'roots' | 'wind' | 'normals'
const DEFAULT_FOLIAGE_APPEARANCE: FoliageAppearance
interface FoliageMaterialOptions
FoliageMaterialOptions.appearance: FoliageAppearance
FoliageMaterialOptions.block: boolean
FoliageMaterialOptions.map: THREE.Texture | null
FoliageMaterialOptions.selectiveTint: boolean
interface FoliageMaterialHandle
FoliageMaterialHandle.material: THREE.Material
FoliageMaterialHandle.bind(mesh: THREE.Mesh): void
function createFoliageMaterial(options: FoliageMaterialOptions): FoliageMaterialHandle
function prepareFoliageInstances(mesh: THREE.InstancedMesh, handle: FoliageMaterialHandle): void

## engine/foliage/GroundCoverGeometry.ts
function createGroundCoverTuft(): THREE.BufferGeometry
function createGroundCoverFlower(): THREE.BufferGeometry
