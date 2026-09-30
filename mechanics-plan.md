# Build plan — RÖDBRÅ: Beneath the Bell

## Genre / archetype
Third-person dark-fantasy action slasher. Recipe read: `engine/agent-docs/mechanic-combat.md`. Over-the-shoulder third-person camera with mouse/stick orbit, collision avoidance, responsive sword combat with light combo, charged heavy attack, sprint/dodge attacks, directional parry/riposte, Rend executions, iron ward throw, checkpoints at iron prayer posts, 4 enemy archetypes, 2 minibosses, and a 3-phase final boss beneath the cracked bronze bell.

## Contract from the recipe
- Camera: Third-person over-the-shoulder with mouse look, subtle auto-recentering, collision avoidance, and camera shake.
- Embodied player: Yes, Liv Ravn with ash-blonde braid, weathered charcoal coat, crimson sash, iron bracers, and broad seax sword.
- Melee combat: Hitbox-based melee strikes, directional parry window, invincible dodge rolls, Rend gauge building toward executions, throwing ward projectile, and estus-style health flask.
- Progression: Checkpoint prayer posts restore health, replenish flask, save game, and offer 3 permanent iron-nail upgrades (Tempered Edge, Woven Charm, Quickened Ward).

## Platform
`primaryPlatform` in `game.json` is `desktop`. Target 16:9, desktop browser with full Keyboard/Mouse and Gamepad dual support. Touch parity actions declared so mobile preview also functions.

## Implementation Architecture
1. **Core Loop & Input (`CombatSystem.ts` / `PlayerController`):**
   - 3-hit light attack combo (Light 1, Light 2, Light 3) with buffer queue.
   - Charged heavy thrust with visual hold charging and increased damage/stagger.
   - Sprint attack and Dodge roll attack.
   - Dodge roll with i-frames and late cancel recovery.
   - Directional Parry with spark burst, sound confirmation, and riposte window.
   - Rend meter system: fills with attacks, spent for cinematic execution on staggered foes.
   - Throw Iron Ward: 3 rechargeable charges, throws spinning iron talisman that stuns/damages.
   - Health Flask: 1 charge replenished at checkpoints.
2. **Enemy Archetypes & AI (`Enemies.ts`):**
   - Hollow Thrall: 3-swing combo, overhead miss recovery vulnerability.
   - Antler Warden: Agile spear/hook lunges, sidestep, parry-focused. Miniboss variant: Antler Chieftain.
   - Mill Butcher: Heavy armored executioner, wide sweep, jumping ground slam, destructible armor plates. Boss variant: Butcher of Vargdal.
   - Bellbound: Rooted ranged priestess, ringing hand bell buffing nearby allies, slow tracking root orb projectiles.
   - Final Boss: The Bell Mother (3 phases with root sweeps, bell toll shockwaves, Hollow Thrall summoning, broken bronze halo berserk mode, and unblockable grab).
3. **Environment & Level Streaming (`LevelManager.ts` / `WorldZones.ts`):**
   - Zone 0: The Last Ring (Tutorial clearing, burning bell tower view).
   - Zone 1: Hushwood Approach (Snowy pine forest, red ribbons, ruined stave chapel, Antler Warden arena).
   - Zone 2: The Red Mill (Abandoned sawmill, frozen river, turning waterwheel, log stacks, chains, lanterns, Mill Butcher arena).
   - Zone 3: Below the Bell (Subterranean stone sanctuary, root vaults, suspended colossal cracked bronze bell, Bell Mother arena).
   - Epilogue: Dawn sanctuary, Elin's altar, final choice (Break Seal vs Offer Blood), 2 ending sequences and credits.
4. **Atmosphere, VFX & Audio (`AudioEffects.ts` / `Atmosphere.ts`):**
   - Ambient snow flurries via `AmbientSnowVFX`.
   - Dark crimson blood splatters, weapon trails, ash bursts (Gore: Off/Reduced/Full).
   - Web Audio Scandinavian folk-horror soundscape (bowed strings, frame drum, bell resonance, whooshes, impacts, clangs).
5. **UI & Menus (`UIManager.ts`):**
   - Start / Title screen with Continue, New Game, Settings, Accessibility, Credits.
   - In-engine intro cutscene with narration and subtitles (skippable).
   - Gameplay HUD: Health bar, Rend gauge, Ward charges, Flask count, Objective banner, Boss health bar, interact hints.
   - Pause menu, Settings modal, Accessibility modal, "THE BELL REMEMBERS" death screen, Ending choice prompt, Credits roll.
