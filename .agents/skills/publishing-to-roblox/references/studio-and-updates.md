# Studio connection, source updates, recovery and saving

Discover the connected tools rather than pinning an observed ABI. Typical operations are
`list_roblox_studios`, `get_studio_state`, hierarchy/source inspection, `multi_edit`, `execute_luau`,
Play controls, console/input, and captures. Every call targets the selected `studio_id`.
Studio MCP and Open Cloud authorization are independent. No helper starts its own MCP client.

Use the connected server's schemas and editor-aware reads. Do not assume Script.Source reflects
an unsaved open buffer. The generated updater requires `ScriptEditorService:GetEditorSource` and
`UpdateSourceAsync`; unavailable permissions stop it, not trigger a stale-Source fallback.
Do not paste an entire game into many improvised edits when a reviewed local package is available.

## Inspect and plan

After preparing the local source package:

```text
node "<bundle>/build-studio-update.mjs" inspect --project <port> --out <new-inspect.luau>
```

Read that generated code, then execute it through the connected MCP executor in the explicitly
selected **Edit** context. Save the returned JSON string's contents as `<live.json>`; unwrap the
tool envelope without editing values. Inspection reads the candidate paths plus managed scripts,
identity, build and pending-run markers. Duplicate names/IDs and occupied non-script paths fail.

```text
node "<bundle>/port-state.mjs" prepare --project <port> --live <live.json> --run <new-run-dir>
```

For the first explicitly selected unbound target add `--bind-target`. This installs the port's
managed UUIDs on apply, not a cloud identity. It never clears the template. For existing unowned
scripts, `--adopt` is allowed only after an explicit ownership decision and exact source/class/path/
enabled matches. First copy their actual editor content into the local package; do not use adoption
to overwrite a different game. Keep source contract/deviations separate from this ownership baseline.

Review `plan.json`: target/owner, source/package hashes, conflicts, desired values, changed scripts,
and preserved customizations. No uploads occur. A conflict result exits 2 and produces no applicable
update. Existing baseline omissions, missing managed objects, foreign path occupants, and divergent
edits are actionable conflicts. Locate a renamed object by stable ID rather than recreating it.

The plan stores complete affected script text locally. Protect it appropriately. Before altering
native models, terrain, assets or global settings, prepare separate complete backups and scoped
expected-value operations; the source helper deliberately does not pretend to cover that content.

## Apply and read back

```text
node "<bundle>/build-studio-update.mjs" apply --project <port> --run <run-dir> --out <new-apply.luau>
```

Review and execute that generated Luau in the same selected Edit target. It rechecks target,
source and hierarchy expectations, stages Script/LocalScript activation, checks editor buffers
inside update callbacks, and commits the build marker only after all managed sources match.
Save the returned snapshot as `<after.json>`:

```text
node "<bundle>/port-state.mjs" accept --project <port> --run <run-dir> --live <after.json>
```

This advances only the source baseline. It does not run gameplay tests or save the place. Native
assets/settings must already satisfy the separate scene/asset plan before calling the whole port
ready. Whole-place atomicity is not provided by Studio MCP or a per-script update callback.

## Interrupted operations

Keep the same run after a timeout. Generate a fresh inspection with `inspect --project <port>
--run <run-dir> --out <new-inspect.luau>` so recovery reads the durable plan even when local
conversion inputs are missing or invalid. Inspect its pending marker and
actual source state, and either replay the existing apply or compensate. A replay accepts only
expected pre-state or this run's identifiable intermediate writes. An unrelated edit stops it.
Do not prepare a new baseline from a half-applied game.

Rollback records `rollback:<run-id>` in `BitmagicPendingRun` before restoring anything. While that
marker remains, new plans and forward replay are blocked; continue the same rollback after resolving
its conflicts. The marker clears only after successful recovery. Per-script recovery markers let
that rollback resume a source write interrupted before its ownership/path bookkeeping finished.

```text
node "<bundle>/build-studio-update.mjs" rollback --project <port> --run <run-dir> --out <new-rollback.luau>
```

Review and execute the generated recovery only for this run. It restores source/ownership/path/
enabled state conditionally; later human edits are preserved and reported. New scripts are removed
only if still attributable to this run, with expected content and no new children. Additional
attributes, tags, or changes to Archivable, RunContext or LinkedSource preserve the script and
report a conflict. Empty Folders created by the run also require their recorded original path,
unchanged attributes/tags and default Archivable state before removal. Missing folder creation
metadata or unreadable properties require manual recovery. It never deletes imported cloud assets.
Keep the returned recovery snapshot and resolve any `rollback-incomplete` entries before continuing.

After a successful rollback, restore the matching local accepted baseline from the run's durable
backup using the returned receipt:

```text
node "<bundle>/port-state.mjs" accept-rollback --project <port> --run <run-dir> --receipt <rollback.json>
```

Never leave the local baseline naming the
reverted build. Cloud versions, purchases and account-data migrations are outside this recovery.

## Saving

After the complete verified game is in Edit state, discover whether a supported MCP operation can
save the complete place. Confirm its semantics: local file or non-published draft, selected
destination, no experience publication. Use it when available within the authorized port workflow.
Reuse an established save destination; ask when one is missing or it would overwrite unrelated work.
Confirm the result against the installed build and record actual evidence with `record-save`.

Do not infer save privilege from `execute_luau`, invent a save tool, request publishing credentials,
or call undocumented privileged APIs. If no supported save exists, finish with “ready in Studio;
save required.” On failure/ambiguous response preserve the project, inspect before retrying, and
report failed/unconfirmed. Source-only Rojo output and script backups are not complete-place saves.

Leave publishing, visibility and release management to the creator in Studio in every case.

- [Studio MCP](https://create.roblox.com/docs/studio/mcp).
- [ScriptEditorService](https://create.roblox.com/docs/reference/engine/classes/ScriptEditorService).
- [Instance attributes, tags and Archivable](https://create.roblox.com/docs/reference/engine/classes/Instance).
- [BaseScript properties](https://create.roblox.com/docs/reference/engine/classes/BaseScript).
