---
name: theming-the-hud
description: Use for any ask about the game's LOOK — "rounder buttons", "orange UI", "neon glow", "glossier", "spooky menu", different fonts, outlines, or styling the mobile buttons. The HUD's look is data (hud.theme), never code.
---

# Theming the HUD

The whole look — colors, fonts, radii, glow, gloss, outlines, decorations, icons — is ONE value:
`worldProfileData.hud.theme`. Never restyle HUD elements in game code for a look request.

Read `engine/agent-docs/HUD_THEMES.md` first — its **"Common asks → minimal patch"** table has
a copyable patch for every frequent request, and value ladders so you never invent magnitudes.

```bash
bitmagic theme show                                        # current theme + validity + contrast report
bitmagic theme patch '{"colors":{"primary":"#FF8800"}}'    # merge-patch: nested objects merge, null deletes
bitmagic theme set rift-raider                             # preset | full inline JSON | @file | default
bitmagic theme check                                       # non-zero exit if the theme won't apply
```

Rules that save a session:

1. **Patch, don't rebuild.** `patch` merges onto the current theme (or the active preset's real
   tokens); resending a whole theme for one change is how values drift.
2. **Read the report the command prints.** `SUBSTITUTED -> renders #X` = the engine derives a
   readable replacement for that pairing (usually fine). `LOW` = a pairing nothing auto-fixes —
   that one is yours.
3. **Then LOOK.** `bitmagic verify` writes `.bitmagic/verify/screenshot.png` with the HUD in
   the picture. A wrong theme never errors — it silently renders the default look — so the
   screenshot is the test.
4. Preset names are hyphenated (`rift-raider`, `village-keep`); display fonts (creepster,
   pacifico, shrikhand, grenze-gotisch) need `"case": "normal"`.
