# RÖDBRÅ: Beneath the Bell

[![Play Online](https://img.shields.io/badge/Play%20Live-bitmagic.ai-red?style=for-the-badge)](https://bitmagic.ai/play/CMA3X07D3773/)
[![Engine](https://img.shields.io/badge/Bitmagic-GDK%20v0.8.2-blue?style=for-the-badge)](https://bitmagic.ai/)
[![WebGPU](https://img.shields.io/badge/Renderer-WebGPU-orange?style=for-the-badge)](#)

> *Winter, 1893. Monster hunter Liv Ravn returns to the isolated Scandinavian valley of Vargdal after every church bell rings simultaneously, despite their clappers having been removed. Nameless dead rise from frozen ground. Beneath the stave church, an ancient root-bound entity known as the Bell Mother awaits...*

Play the full browser game now: **[https://bitmagic.ai/play/CMA3X07D3773/](https://bitmagic.ai/play/CMA3X07D3773/)**

---

## ⚔️ Game Overview

**RÖDBRÅ: Beneath the Bell** is a third-person dark-fantasy action slasher developed with the Bitmagic Engine and WebGPU.

- **Protagonist**: Liv Ravn — weathered charcoal coat, practical armor, ash-blonde braid, crimson sash, iron ward talisman, and a broad single-edged seax sword.
- **Visual Aesthetic**: Scandinavian Nordic folk-horror featuring moonlit dusk skies, falling snow flurries, candlelit roadside shrines, turning watermills, and subterranean crypt vaults.
- **Combat**: 3-hit light attack combo, charged heavy thrust, invincible dodge rolls, directional parry/riposte, Rend executions, rechargeable iron ward throw, and estus-style health flask.
- **Progression**: Checkpoint Iron Prayer Posts restore resources and allow spending collected Iron Nails on permanent upgrades:
  - *Tempered Edge*: +15% sword damage
  - *Woven Charm*: +20% maximum health
  - *Quickened Ward*: -20% ward recharge cooldown
- **Bosses & Enemies**:
  1. *Hollow Thrall*: Awakened corpse with crude iron sickle; vulnerable overhead recovery.
  2. *Antler Warden & Chieftain*: Fast, agile spear enemies with lunges and sidesteps.
  3. *The Butcher of Vargdal*: Heavy executioner with wide cleaves, jump slams, and destructible armor plate.
  4. *Bellbound Priestess*: Ranged support casting slow tracking root orbs.
  5. *The Bell Mother (Final Boss)*: 3-phase fight beneath the cracked colossal bronze bell featuring root sweeps, Hollow Thrall summons, expanding floor shockwaves with safe gaps, and a telegraphed grab attack.
- **Endings**: A critical epilogue choice at Elin's altar deciding the fate of Vargdal (*Sever the Roots* vs *The Ravn Rite*).

---

## 🎮 Controls

| Action | Desktop (Keyboard & Mouse) | Gamepad | Mobile (Touch) |
| :--- | :--- | :--- | :--- |
| **Move** | `W` `A` `S` `D` | Left Stick | Virtual Joystick |
| **Camera Orbit** | Mouse | Right Stick | Drag screen |
| **Sprint** | `Shift` (Hold) | `L3` / Click Left Stick | Auto / Sprint Button |
| **Light Attack** | Left Click | `X` / `Square` | Tap Attack |
| **Charged Heavy Attack** | Right Click (Hold & Release) | `Y` / `Triangle` | Hold Attack |
| **Dodge Roll (i-frames)** | `Space` | `B` / `Circle` | Roll Button |
| **Directional Parry** | `Q` / `F` / Middle Click | `LB` / `L1` | `PARRY` |
| **Throw Iron Ward** | `E` | `RB` / `R1` | `WARD` |
| **Heal Flask** | `R` | `D-Pad Down` | `HEAL` |
| **Rend Execution** | `X` (when 100% Rend) | `RT` / `R2` | `REND` |
| **Target Lock-On** | `Tab` / `T` | `R3` / Click Right Stick | `LOCK` |
| **Interact / Checkpoint** | `E` | `A` / `Cross` | Context Prompt |
| **Pause / Settings** | `Escape` / `P` | `Start` / `Options` | `PAUSE` |

---

## 🗺️ World Zones

1. **Prologue — The Last Ring**: Snowy mountain pass, stone altar to draw the seax blade, and first roadside shrine.
2. **Hushwood Approach**: Dense snowy pine forest draped in red ritual ribbons, hidden nail cache, and the Stave Chapel arena guarded by the Antler Chieftain.
3. **The Red Mill**: Abandoned sawmill settlement on a frozen river, turning timber waterwheel, swinging pendulum blade timing hazard, and The Butcher of Vargdal arena.
4. **Below the Bell**: Vaulted subterranean sanctuary, colossal cracked bronze bell with glowing fissure light, Elin's root altar, and the 3-phase Bell Mother encounter.
5. **Epilogue & Dawn**: Player choice, dawn cinematics, subtitles, and ending credits.

---

## 🛠️ Development

Built using the [Bitmagic Game Development Kit (GDK)](https://bitmagic.ai).

```bash
# Start local development server (Game & Editor)
bitmagic dev

# Typecheck against engine API
bitmagic check

# Headless browser verification test
bitmagic verify
bitmagic verify --platform mobile

# Publish to bitmagic.ai
bitmagic publish --visibility public
```
