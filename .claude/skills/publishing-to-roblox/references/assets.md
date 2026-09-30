# Original assets and packed geometry

For each reachable asset try: permission-valid cached original → supported direct import →
deterministic conversion → faithful native approximation → licensed/generated replacement.
Record a valid attempted route or concrete preflight blocker, not blind repeated retries. Missing
gameplay-critical content blocks completion unless the creator explicitly changes the contract.

Use the source bytes, not screenshots, whenever possible. Packed mesh JSON, articulated components,
procedural buildings and audio-bank URLs count as original content. Retain source bytes, decoder
version, conversion recipe and hash, target owner/type/ID/version, upload operation, and evidence.
Reuse by bytes + recipe + importer version + owner/permission context, not filename.

Studio's importer and Open Cloud asset endpoints have distinct format/settings capabilities.
Discover the current route. GLB/glTF Model creation is documented; a raw Mesh upload is not a
general geometry uploader, and content updates are more restricted than asset creation. Tool
`insert_asset` inserts an existing asset; `store_image` produces a tool reference, not a permanent
game image. Neither transfers all local models/audio automatically.

## Offline packed-mesh helper

`export-packed-mesh.mjs` supports these explicit, little-endian layouts only:

| Layout | Buffers | Other semantics |
| --- | --- | --- |
| `bitmagic-packed-v1`, kit `version: 1` | Unindexed float32 XYZ positions/normals/RGB colors | Optional pivot, height and muzzleHeight. |
| `bitmagic-packed-v2`, kit `version: 2` | int16 positions × quantum; normalized int8 normals; uint8 colors; uint16 indices | Ordered `[start,count,materialIndex]` groups and articulated pivots. |

Unknown fields/layouts fail. Read the actual source decoder before selecting one. The helper does
not extract arbitrary procedural code, skin/retarget skeletal animation, bake textures, import
into Studio, upload assets, or prove visual parity. Those remain explicit conversion tasks.

Save a recipe in the port workspace. This calibration example preserves source axes and scale;
choose measured values for the actual game:

```json
{
  "schemaVersion": 1,
  "format": "bitmagic-packed-v1",
  "meshIds": ["townhall"],
  "basis": [1,0,0, 0,1,0, 0,0,1],
  "scale": 1,
  "materials": [{
    "name": "source-painted",
    "doubleSided": false,
    "pbrMetallicRoughness": {
      "baseColorFactor": [1,1,1,1],
      "metallicFactor": 0,
      "roughnessFactor": 0.8
    }
  }]
}
```

```text
node "<bundle>/export-packed-mesh.mjs" --input <original-kit.json> --recipe <recipe.json> --out <new-model.glb>
```

It emits GLB plus `<new-model.glb>.json` with hashes, mesh IDs, triangles, vertices and original
pivot metadata. It preserves pivot translations, vertex colors and material groups, transforms
normals, and reverses winding for a reflected basis. Select only reachable mesh IDs; articulated
components must share the intended hierarchy after native import. Preserve muzzle/footprint
metadata in native code even if the importer ignores GLB extras.

Verify silhouette, dimensions, pivot articulation, colors/PBR, grounding, sockets, collision roles
and animation timing after import. Vertex colors surviving a GLB export do not prove the chosen
Roblox import preserves their appearance. If necessary bake an atlas and record that conversion.
Gray replacement materials are not an acceptable silent success. Use inexpensive dedicated
collision geometry, and disable collision/touch/query for decorative content where appropriate.

Zero-area triangles are rejected by default. If inspection confirms that these are degenerate
source faces, set `"degenerateTriangles": "drop"` in the recipe. The receipt records original,
retained and dropped triangle counts; the converter removes unused vertices too. It never
invents normals for retained surfaces. Include the cleanup in the accepted conversion evidence.

## Uploads, permissions and native reconstruction

Use only the selected creator/group owner and declared dependencies. Asset upload, moderation,
experience permissions, and working playback/rendering are separate states. Private ownership
does not prove a target experience can play audio. If asset permissions need an existing place,
ask the creator to establish that in Studio; do not create/publish an experience yourself.

Track operations before polling; after ambiguous timeouts query their actual outcome before
creating duplicates. Bound retries/concurrency and follow throttling. Preserve previous asset
mappings when changed content requires a new ID. Avoid auto-updating live package dependencies.
Never upload secrets, unrelated local files, recovery archives, or signed URL credentials.

Keep original voices, cue timing, subtitles, cooldowns, overlap caps and ducking. Generic growls
are a replacement, not proof the original voice pack transferred. Source cosmetics/content changes
are intentional overrides only when requested; do not infer them from platform stereotypes.

Store native construction recipes and per-object identities/property snapshots in the port
workspace. Recipes must support scoped updates; do not run a full rebuild that erases unrelated
models. Inspect imported marketplace models for embedded scripts before executing them.

When an image-upload tool needs temporary HTTP hosting, expose only the intended export directory,
bind narrowly, record the owned PID/port, and stop it and its children after the transfer.

- [Studio importer](https://create.roblox.com/docs/studio/importer).
- [Assets API guide](https://create.roblox.com/docs/cloud/guides/usage-assets).
- [Audio assets](https://create.roblox.com/docs/audio/assets).
