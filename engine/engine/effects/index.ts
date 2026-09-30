export { AmbientSnowVFX, DEFAULT_AMBIENT_SNOW_VFX_OPTIONS } from 'engine/effects/AmbientSnowVFX.js';
export type { AmbientSnowVFXOptions } from 'engine/effects/AmbientSnowVFX.js';
export { DamageFlash, createDamageFlash } from 'engine/effects/DamageFlash.js';
export type { DamageFlashConfig } from 'engine/effects/DamageFlash.js';
export { createBloodSplatterEffect, createCombatEffects } from 'engine/effects/HitEffects.js';
export {
    CircleTelegraph,
    ConeTelegraph,
    LineTelegraph,
    GroundZone,
    OrbEffect,
    DEFAULT_CIRCLE_TELEGRAPH_CONFIG,
    DEFAULT_CONE_TELEGRAPH_CONFIG,
    DEFAULT_LINE_TELEGRAPH_CONFIG,
    DEFAULT_GROUND_ZONE_CONFIG,
    DEFAULT_ORB_EFFECT_CONFIG,
    ZONE_THEME_COLORS,
    ORB_TYPE_COLORS,
} from 'engine/effects/TelegraphVFX.js';
export type { CircleTelegraphConfig, ConeTelegraphConfig, LineTelegraphConfig, GroundZoneConfig, OrbEffectConfig } from 'engine/effects/TelegraphVFX.js';

export { VisualEffects, getVisualEffects, DEFAULT_VISUAL_EFFECTS_OPTIONS, DEFAULT_EMITTER_OPTIONS } from 'engine/effects/VisualEffects.js';
export type { VisualEffectsOptions, EffectHandle, EmitterOptions, EmitterHandle, ExplosionSpawnOptions, BurstSpawnOptions, LightningSpawnOptions } from 'engine/effects/VisualEffects.js';
export { ExplosionVisual, DEFAULT_EXPLOSION_VISUAL_OPTIONS } from 'engine/effects/ExplosionVisual.js';
export type { ExplosionVisualOptions, ExplosionStyle } from 'engine/effects/ExplosionVisual.js';
export { EXPLOSION_PRESETS } from 'engine/effects/ExplosionPresets.js';
export type { ExplosionPreset, ExplosionLayer, ExplosionRecipe } from 'engine/effects/ExplosionPresets.js';
export { BURST_PRESETS } from 'engine/effects/BurstPresets.js';
export type { BurstPreset, BurstRecipe, BurstMotion } from 'engine/effects/BurstPresets.js';
export { BurstVisual, DEFAULT_BURST_OPTIONS } from 'engine/effects/BurstVisual.js';
export type { BurstOptions } from 'engine/effects/BurstVisual.js';
export { LightningVisual, LIGHTNING_PRESETS, DEFAULT_LIGHTNING_OPTIONS } from 'engine/effects/LightningVisual.js';
export type { LightningPreset, BeamPreset, LightningOptions } from 'engine/effects/LightningVisual.js';
export type { VFXQuality, VFXStyle } from 'engine/effects/VFXUtils.js';
export { DEFAULT_EFFECT_SHAPE_OPTIONS } from 'engine/effects/EffectShapes.js';
export type { EffectShapeOptions, EffectTarget } from 'engine/effects/EffectShapes.js';
export { FireVisual, FIRE_PRESETS } from 'engine/effects/FireVisual.js';
export type { FirePreset } from 'engine/effects/FireVisual.js';
export { ShieldVisual, SHIELD_PRESETS } from 'engine/effects/ShieldVisual.js';
export type { ShieldPreset } from 'engine/effects/ShieldVisual.js';
export { SurfaceVisual, SURFACE_PRESETS } from 'engine/effects/SurfaceVisual.js';
export type { SurfacePreset } from 'engine/effects/SurfaceVisual.js';
export { RibbonTrailVisual, TRAIL_PRESETS, DEFAULT_TRAIL_OPTIONS } from 'engine/effects/RibbonTrailVisual.js';
export type { TrailPreset, TrailOptions } from 'engine/effects/RibbonTrailVisual.js';
export { TransitionVisual, TRANSITION_PRESETS } from 'engine/effects/TransitionVisual.js';
export type { TransitionPreset } from 'engine/effects/TransitionVisual.js';
export type { FollowEffectHandle, FireEffectHandle, ShieldEffectHandle, ContinuousBeamHandle, TrailHandle } from 'engine/effects/VisualEffects.js';

export { CustomEffectVisual, DEFAULT_CUSTOM_EFFECT_OPTIONS } from 'engine/effects/CustomEffectVisual.js';
export type { CustomEffectOptions, CustomEffectDefinition } from 'engine/effects/CustomEffectVisual.js';
export { effectRandom, effectDensity, effectNumber, updateEffectAttribute } from 'engine/effects/VFXUtils.js';
