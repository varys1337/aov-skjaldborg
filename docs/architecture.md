# Age of Vikings - Skjaldborg Architecture Notes

Version 0.7.0 targets Foundry VTT 14.370+ and Age of Vikings 14.7+. Manifest and runtime minimum/verified declarations are 14.370 and 14.7 respectively. The release policy explicitly accepts automated source/API, contract, and packaging checks for these declarations; live Foundry gameplay remains untested. Keep optimizations incremental: preserve public facades, persisted flags, settings keys, socket action names, and combat state fields unless a separate migration plan explicitly changes them.

## Runtime Flow

- `scripts/main.mjs` is the startup coordinator. It registers settings during `init`, AoV compatibility and initiative integration during `setup`, and runtime features during `ready`.
- Runtime features are registered through `scripts/core/feature-registry.mjs`. Each initializer receives a scoped registrar which records the real `Hooks.on`/`Hooks.once` ids and prevents duplicate feature initialization.
- `game.aovSkjaldborg` is the public diagnostic/control surface. Do not remove existing properties without a migration note and compatibility fallback.

## Stable Facades

- `scripts/adapter/aov-adapter.mjs` is the stable AoV facade. Installed-system imports and template identifiers are centralized in `scripts/adapter/aov-contract.mjs`; runtime modules must not embed `systems/aov/...` paths outside that adapter boundary.
- `scripts/combat/movement-controller.mjs` remains the movement facade. Low-risk internals can move to focused movement modules, as with capture notification batching, while `registerMovementHooks`, `startMovementPhase`, and exported movement helpers stay stable.
- `scripts/apps/actor-hotbar.mjs` remains the actor hotbar facade. Hook invalidation now lives in `scripts/apps/actor-hotbar/hooks.mjs`; callers should continue importing `ActorHotbar` and `registerActorHotbarHooks` from the facade.
- `scripts/socket.mjs` remains the socket facade. Shared payload cleaners belong in `scripts/socket/sanitizers.mjs`; each descriptor in `scripts/socket/schema.mjs` owns sanitization, resolution, authority, execution, timeout, and result-normalization behavior; base authority checks belong in `scripts/socket/authority.mjs`.
- Pure route cleaning/merging belongs in `scripts/combat/movement-route.mjs`; existing controller exports remain compatibility re-exports.
- Lazy dialog launchers belong in `scripts/apps/dialog-launchers.mjs`. The hotbar action helper re-exports the same functions for existing callers.

## Socket Workflow

- Player writes route through the socket unless the current user is the active GM.
- Keep request ids, stale document guards, timeout handling, and user-facing warning text stable.
- All local-GM and remote-GM requests use the same schema-backed envelope pipeline. New actions must provide a descriptor and runtime binding without changing existing action ids or schema-version semantics.
- Do not serialize live Foundry documents through the socket. Send ids, UUIDs, and plain payload data only.

## UI And Dialog Workflow

- New or refactored UI should use documented Foundry v14 ApplicationV2/DialogV2 patterns.
- Module-owned DialogV2 subclasses use `scripts/apps/base/dialog-v2.mjs`.
  Dynamic content changes request one coalesced `ApplicationV2#_refit`; the
  guarded path remains inert before Foundry 14.365.
- ApplicationV2 render calls use render-option objects, never the legacy
  boolean render signature.
- Shared dialog behavior should move toward the existing base helpers in `scripts/apps/base`, but only one dialog family at a time.
- UI state should derive from document data or explicit submitted form data. Avoid hidden client state that can desync from Foundry documents.
- Actor hotbar rendering is part-aware and coordinated through `RenderCoordinator`. Prefer targeted invalidation when the affected region is known; request a full shell render only for structural changes.
- Scheduled and explicit coordinator flushes share one asynchronous drain. Invalidations during a render are processed in a following batch; a failed surface is logged without discarding other surfaces. Surface handlers must not await their own coordinator flush.
- Presentation caches use actor/category generations and share pending asynchronous builds. Invalidation prevents an old completion from replacing newer cached data.
- Pending XP/preparation controls prevent duplicate submissions only. Document hooks still invalidate caches and schedule affected regions; controls clear their busy state on success and failure.

## Chat Messages

- All module-authored messages are created through
  `scripts/compat/chat-message.mjs`; direct `ChatMessage.create` calls outside
  that boundary are rejected by validation.
- Explicit audience data remains authoritative. Apply the Foundry message mode
  only for cards that intentionally follow the current client's selection.
- Foundry 14.365 `notify` and `scroll` operation options are used only through
  named delivery policies. Automated phase reports use the background policy
  so they do not interrupt the current chat position.
- `renderChatMessageHTML` handlers consume the documented v14 `HTMLElement`
  argument. Do not reintroduce jQuery or array-like wrapper branches.

## Movement Workflow

- Movement capture, route storage, execution, engagement checks, and recovery are GM-authoritative.
- Keep route revision, route id, stale state, and movement status semantics unchanged when extracting movement internals.
- Movement helpers should remain deterministic and tolerate partial token/combatant data. Avoid relying on in-flight placeable animation state when persisted token source data is required.
- Movement-plan settlement is deadline-bounded without cancelling queued writes. `startMovementPhase` returns `null` with the existing pending-plans warning when settlement times out; callers must stop further progression.

## Settings, Diagnostics, And Source Organization

- World migrations run on the selected authoritative GM; client migrations run for each user. Save completion markers only after required writes succeed. No schema or migration-version change is introduced by the maintenance cleanup.
- Performance detail factories run only for enabled measurements. Ending a measurement clears its pending mark even if diagnostics were disabled meanwhile.
- Hotbar SCSS lives under `src/styles/apps/actor-hotbar`; ring, knockback, and prone-note styles have their own app partials. The legacy aggregator preserves the established interleaving and cascade. Do not delete competing overrides without visual verification.
- `tools/module-tool.mjs` retains command dispatch and the existing contract harness, followed by the Desktop checkout's retained regression suite in a separate process. `tools/lib/validation.mjs`, `packaging.mjs`, and `workspace.mjs` own validation, packaging, and shared filesystem helpers. Historical CLI entry points delegate through `legacy-cli.mjs`. Reuse the runtime version comparator and AoV path catalog instead of duplicating them.

## Manual Verification

Run `npm run validate` and `npm run test:contracts` before packaging. The
validator is read-only and checks syntax, metadata, imports, templates,
localization, release CSS, AppV2/chat boundaries, and the AoV source
contract when available. Set `AOV_SYSTEM_PATH` to an AoV system directory;
standalone validation reports an explicit skip when it is unavailable.
`npm run build` requires the AoV contract and fails before touching build
outputs if the source directory is unavailable. It
creates a deterministic runtime folder and ZIP without rewriting source files.
Its public assets are `release/aov-skjaldborg.zip`, `release/module.json`, and
`release/SHA256SUMS.txt`. The ZIP retains the `aov-skjaldborg/` top-level directory.
Optional `--tag v<version>` input must match the source version before any build
outputs change. CI obtains AoV 14.7 at the commit declared by
`AOV_CONTRACT_REFERENCE`, runs the same checks, and compares consecutive builds.

Static checks do not replace in-app validation. After each staged refactor,
manually verify module startup, combat phases, intent declaration and commit,
attack/missile/defense dialogs, movement planning and execution,
engagement/disengagement, actor hotbar updates, socket routing as GM and player,
chat cards, overlays, and settings apps.
