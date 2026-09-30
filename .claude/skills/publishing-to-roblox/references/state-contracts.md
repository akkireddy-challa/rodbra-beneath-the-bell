# Port workspace and helper contracts

The helper bundle is found with `bitmagic tools path roblox-port --json`. Use its returned `path`
as `<bundle>` below. The normal route executes it in place; `tools install roblox-port` is optional
and copies helpers into `tools/roblox-port`, never into generated game modules. All helper commands
are local-only. Inputs/outputs are explicit files; helpers never choose a Studio session.

## Initialize

```text
node "<bundle>/port-state.mjs" init --source <absolute-bitmagic-project> --project <new-sibling-port>
```

The source must have a game ID and engine version in `bitmagic.json`. If it lacks an environment,
provide `--environment` with the confirmed source environment. The output must not exist or nest
inside the source. Initialization creates stable project/target UUIDs, empty inventories and
generated/override/test/state directories. Fill the inventories before using them; initialization
is not a generated or verified game. Existing ports need explicit mapping/adoption, not `init`
over their files. An empty sibling workspace can hold an adopted port's copied local sources.

Commit `project.json`, `incoming.json`, `port-contract.json`, `assets.lock.json`, generated source,
overrides, tests and `state/base.json` according to the project's VCS policy. Keep journals and
recovery snapshots under `.bitmagic/roblox/runs/`; they are ignored for sharing, but retain them
until recovery is no longer needed. Only conversion cache is disposable. Never store credentials
in these files, asset recipes, Lua source, tool outputs, or archives.

`project.json` contains schema version 1, immutable managed project/target IDs, source identity,
runtime profile, and nullable target `placeId`/`universeId` strings. Fill known target IDs before
applying. A null binding may be used for an explicitly selected unsaved template. Do not store a
transient Studio session ID as the durable identity. Reconcile later owner-created cloud IDs while
retaining the managed UUIDs.

## Generated sources

Prepare `incoming.json`:

```json
{
  "schemaVersion": 1,
  "sourceFiles": ["bitmagic.json", "src/work/Game.ts", "src/work/game.json", "src/work/world.json"],
  "scripts": [
    {
      "id": "rules",
      "path": ["ReplicatedStorage", "BitmagicGame", "Rules"],
      "className": "ModuleScript",
      "file": "generated/shared/Rules.luau"
    },
    {
      "id": "client-entry",
      "path": ["StarterPlayer", "StarterPlayerScripts", "BitmagicGame", "Main"],
      "className": "LocalScript",
      "file": "generated/client/Main.client.luau",
      "enabled": true
    }
  ]
}
```

Declare **every source file used by conversion**, including imported rules, packed art and audio
registries, plus relevant engine dependencies. `sourceFiles` is an explicit inventory, not an
automatic dependency scanner; undeclared changes cannot be detected by the helper. Paths are
relative to the source root, generated files relative to the port root; escaping symlinks and
traversal are rejected. Allowed root services are ReplicatedStorage, ServerScriptService,
ServerStorage, StarterPlayer, StarterGui and Workspace. Use simple generated path segments;
live creator names, including spaces and Unicode, are preserved by stable ID. Existing
Folder/Model/StarterPlayerScripts/StarterCharacterScripts containers can hold scripts; missing
intermediate containers become Folders. Explicitly create special native containers beforehand.

Every Script/LocalScript needs an explicit `enabled`; ModuleScripts omit it. Stable IDs do not
change when names/paths change. The source helper supports up to 256 scripts, each at most 1 MiB.
It does not remove omitted scripts, change classes, or reconcile native models/properties.
Retirement and class migration require a separate backed-up, explicit operation and baseline
migration. Resolve an unsupported operation instead of hand-editing a prepared plan.

## Feature and asset ledgers

`port-contract.json` has schema version 1 with `features` and `deviations` arrays. Each feature
needs stable `id`, source files/symbols, `required`, target strategy, fidelity, dependencies,
test fixture and verification evidence. Accepted differences record the creator's decision and
affected feature IDs. This is the agent's semantic contract; the source helper does not certify it.

`assets.lock.json` has schema version 1 and `assets`. For each asset record `id`, source path/hash,
provenance, recipe/version/hash, target owner/type/ID/version, operation ID, moderation, permissions,
and validation evidence. Store service IDs as strings. Preserve earlier mappings for recovery.

Track native objects/settings outside the script helper in a reviewable scene inventory and
recipes with expected-value updates and durable before-snapshots. A full game includes this state.

## Plan, apply, accept

See [studio-and-updates.md](studio-and-updates.md) for the exact commands. A run directory contains
immutable `plan.json` and `before.json` written before Studio mutation, followed by journal and
readback. The plan binds source/package hashes, target identity, expected live values and baseline.
Do not edit its hash or values to force a mismatch through. Prepare again after resolving the cause.

`accept` means exact managed source readback passed, **not** gameplay, visuals or performance passed.
It stores generated values and applied values separately in `state/base.json`; keep both. An
interrupted forward apply can be replayed from the same plan after inspecting target state, or
conditionally rolled back. New plans are refused while Studio reports an incomplete run.

Local helper operations use `state/lock`. A stale lock after a killed local process needs inspection:
verify the owning PID no longer exists and no other task uses the port before removing it. Never
remove a lock merely because a command is slow. The lock does not prevent human/Team Create edits;
Studio expected-value checks still apply.

## Save evidence and completion

Record actual tool/manual evidence in a save receipt, never infer it from local source output:

```json
{
  "buildId": "the-accepted-plan-hash",
  "status": "saved",
  "destination": "confirmed place file or non-published draft destination",
  "evidence": "actual save operation receipt or verified file evidence",
  "published": false
}
```

```text
node "<bundle>/port-state.mjs" record-save --project <port> --receipt <save.json>
node "<bundle>/port-state.mjs" status --project <port>
```

Statuses are `pending`, `saved`, `unsupported`, `failed`, and `unconfirmed`. The helper validates
receipt shape/build binding; the agent must obtain genuine evidence. Local `status` reports source
freshness and recorded save state; it cannot know whether Studio changed since the last readback.
Reinspect before claiming the current Studio project is unchanged or saved. A new local package
or accepted build invalidates applicability of older save evidence.
