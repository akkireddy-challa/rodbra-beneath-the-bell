# Verify the installed Roblox port

Bind evidence to source/package hashes, live overrides, asset versions, native settings, tool
versions, and the installed `BitmagicBuildId` attribute. Inspect Edit state before each relevant
test, then use a fresh Play context. A cached Edit-mode `require` can return old code.

Maintain independent results for:

| Check | Evidence |
| --- | --- |
| Source/data | Luau syntax/type checks and complete tables/configurations. |
| Rules | Fixed inputs and expected outputs/event sequences; defined numeric tolerances. |
| Native integration | Fresh correct Client/Server contexts, build marker, clean console, working dependencies. |
| Visual/input | Valid observed views/UI interactions at recorded desktop/touch viewports. |
| Performance | Named hardware, quality, resolution, foreground state, duration and representative load. |
| Saved | Confirmed complete-project save receipt/file evidence for this build, if supported. |

An earlier row does not imply later rows passed. Test stubs are not Roblox rendering, input,
replication, asset moderation or audio. Do not enable unsafe runtime `loadstring` to run tests.
Explicit owner inspection can provide manual evidence. Missing checks remain unverified, not green.

## Minimum player-journey contract

Derive concrete cases from the source inventory, including later progression:

- Title, briefing, map/level selection, build/play, combat, results, return, defeat/retry and replay.
- Every tutorial stage, legal/illegal actions, affordability/recovery, unlock and start gating.
- Rule tables, specialized enemies/abilities, damage boundaries, rewards and single payouts.
- Repeated full cycles: no duplicate input handlers, stale UI/audio/camera ownership or accumulating instances.
- Persistence across sessions/rejoining when required; session carry-over alone is not persistence.
- Required icons, mesh identities/materials, correct scale/grounding, pivots/sockets and animation timing.
- Feedback that communicates mechanics: splash radius, piercing corridor, attacks and meaningful impact.
- Desktop, portrait phone and short landscape: safe areas, text, scrolling, touch confirmation,
  placement visibility, selected controls, pause/music and controller focus where supported.
- Existing target-only commerce/customization stays intact; inspect cancellation/unknown ownership,
  receipt deduplication and rejoin behavior if those integrations are part of the port.

Use public UI for a short smoke journey. Test hooks may accelerate long scenarios, but label them
and exclude temporary cheats/fixtures from the final Edit project. Poll a bounded ready/build marker
instead of arbitrary sleeps. Stop bounded retries and preserve the last error when evidence fails.

Do not assume JavaScript PRNG streams match Roblox Random. Specify shared deterministic decisions
or compare exported fixtures. Counts of simulated actors differ from the number actually rendered.
Report sampling and visible role representation; reducing density requires a disclosed decision.

Profile cold load, mass spawn, collision/contact, peak VFX/audio, boss cases, and repeated returns.
Record frame-time distributions, simulation and presentation CPU costs, memory/instance/connection
growth, asset stalls and relevant traffic separately. A headless rules benchmark is not FPS.
Background-throttled Studio measurements cannot certify foreground or mobile performance.

## Captures and handoff

Check that a screenshot is the intended build/view and includes the GUI under test. Reject blank,
magenta, locked-screen, wrong-session or missing-overlay evidence. When MCP capture cannot observe
the UI, give the creator a precise view/action to inspect rather than claiming it passed.

After tests, return task-started Play to Edit and ensure all required content lives there. Remove
temporary fixtures, disable test hooks, and stop task-owned servers/children/ports. Leave unrelated
processes and Studio open. Save through a supported MCP operation if available and report its status.

Completion is a complete game ready in Studio with required checks/deviations accounted for.
Published-client testing, cloud release and public availability are the creator's subsequent
workflow. Never turn “not published yet” into a reason to add publishing automation.
