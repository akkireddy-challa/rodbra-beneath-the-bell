---
name: working-with-the-creator
description: Use when the creator is watching or editing the game alongside you — they moved or added objects in the Editor tab, pasted a screenshot of the running game, asked to try it on their phone, or pressed "Generate high-quality version"; and whenever you need to read `.bitmagic/edit/events.jsonl` or `.bitmagic/jobs/` to find out what they did.
---

# Working alongside the creator

`bitmagic dev` serves one page with two tabs — **Game**, where the owner plays, and **Editor**,
where they click an object and drag a gizmo. A drag writes the new transform straight into
`src/work/world.json`, one entry per object touched. So `world.json` is shared ground, not yours
alone.

- **Re-read `src/work/world.json` before editing it.** The copy you read earlier in the session
  may be stale, and a whole-file rewrite from that copy silently reverts what they just placed.
- **Prefer changing the entries you mean to change** over regenerating `environmentObjects`
  wholesale, so their placements survive your edit.
- **An image pasted into the conversation is probably a frame from their running game.** The dev
  view has a Screenshot button that copies the current frame to the clipboard, so "look at this"
  usually means the game as it is right now — not a reference or a mock-up.

## They can watch your generations — but not your failures

Every `bitmagic generate` and `bitmagic forge` records itself in `.bitmagic/jobs/` while it
runs, and the dev view lists those with your progress lines and the prompt you used. One that
FAILS simply drops off that list, with the error reaching your terminal and nowhere else — **a
failure you do not mention is one they never learn about.**

Those files are yours to read too. Check them before starting a second generation that needs a
browser: a forge and a prop each want one and will fight over it.

## Their phone

`bitmagic dev --mobile` serves the game to their own network and writes a QR code to
`.bitmagic/mobile-qr.png` (the URL is `mobileUrl` in `.bitmagic/dev.json`). Hand them the
image, and say their phone warns once about the certificate — tap Show Details, then Visit Website.
It is a restart, not a flag you can add to a running server.

## `.bitmagic/edit/events.jsonl`

Every editor action is appended there as one JSON object per line, and printed to `bitmagic dev`'s
own output. The file is append-only and never rewritten, so you can re-read it from where you left
off.

```
{"at":"…","event":"object.moved","objectId":"inst_…","position":{"from":{…},"to":{…}}}
{"at":"…","event":"object.added","objectId":"inst_…","type":"tree_oak"}
{"at":"…","event":"object.deleted","objectId":"inst_…"}
{"at":"…","event":"hq.requested","assetId":"asset_…","prompt":"…","command":"bitmagic generate prop …"}
```

| Event | What it means | Expected of you |
|---|---|---|
| `object.moved` / `object.added` / `object.deleted` | History. `world.json` already says so; the line tells you WHO changed it and from what | Nothing |
| `hq.started` / `hq.completed` | The human pressed "Generate high-quality version" and the editor ran it: an asset's mesh was regenerated and every placed instance upgraded with it | Nothing — but read these rather than being surprised by an asset that changed on its own |
| `hq.requested` | The editor could NOT run that generation, normally because nobody is logged in | **Run the command it carries** |

`hq.requested` is the one line that asks something of you:

```
bitmagic generate prop --asset <assetId> --prompt "<prompt>" --json
```

That generates the mesh, voxelizes it to the asset's recorded `fitBox`, and upserts it under the
same asset id, so every placed instance upgrades at once. They asked for it, so run it — just never
twice for the same request. If it fails after the mesh was generated, the error and the JSON result
carry the mesh URL: retry with `--glb-url <url>` to skip the step that already succeeded.
