# engine-api-examples

Auto-generated engine API signature digest — public surface only, bodies omitted.
Format: `Class.method(params): ReturnType`. Regenerated when the engine changes; do not edit.

## engine/examples/MeleeWeaponGuide.ts
const DUELIST_SABRE_PRESET: WeaponPreset
function createDuelistSabre(group: THREE.Group, preset: WeaponPreset, style: WeaponVisualStyle): number
function registerDuelistSabres(): void

## engine/examples/RangedWeaponGuide.ts
function registerTrailCarbines(): void
const BARREL_ROTATION = Math.PI / 2
const PISTOL_PRESET_TEMPLATE: RangedWeaponPreset
const RIFLE_PRESET_TEMPLATE: RangedWeaponPreset
const LAUNCHER_PRESET_TEMPLATE: RangedWeaponPreset
const DUAL_PISTOL_PRESET_TEMPLATE: RangedWeaponPreset
const MATERIAL_PRESETS = { // MILITARY metalDark: { color: 0x1a1a1a, metalness: 0.85,
function createBarrel(group: THREE.Group, radius: number, length: number, position: THREE.Vector3, material: THREE.Material, tapered = false, taperRatio = 0.85): THREE.Mesh
function createReceiver(group: THREE.Group, width: number, height: number, depth: number, position: THREE.Vector3, material: THREE.Material): THREE.Mesh
function createPistolGrip(group: THREE.Group, width: number, height: number, depth: number, position: THREE.Vector3, material: THREE.Material, tiltAngle = -0.2): THREE.Mesh
function createStock(group: THREE.Group, width: number, height: number, depth: number, position: THREE.Vector3, material: THREE.Material, addButtPad = true): THREE.Mesh
function createHandguard(group: THREE.Group, radius: number, length: number, position: THREE.Vector3, material: THREE.Material): THREE.Mesh
function createMagazine(group: THREE.Group, width: number, height: number, depth: number, position: THREE.Vector3, material: THREE.Material, tiltAngle = -0.1): THREE.Mesh
function createIronSights(group: THREE.Group, frontPosition: THREE.Vector3, rearPosition: THREE.Vector3, material: THREE.Material): void
