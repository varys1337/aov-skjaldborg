# Saved-action synchronization and ActionRing listener audit

Date: 2026-11-02. Requested target: Foundry VTT v14.369+ with AoV 14.5.

Both Downloads plans were inspected against the current workspace. The referenced
chat contains the request and assistant-reference placeholders; the attached
plans and local source supplied the actionable detail. Upstream HUD code was
inspiration only. No dependency or behavior was imported from another module.

There is no usable Git repository metadata in this workspace (`git status`
reports that it is not a repository), so branch and HEAD cannot be established.
The snapshot commit named in the plans is not asserted as the local baseline.
Module/package version remains 0.6.0. Existing changes from the earlier combat
plans were preserved. Originals and SHA-256 hashes for the four modified source
and harness files were saved before editing.

## Confirmed defects and scope

| Plan | Reproduction against the original source | Correction |
| --- | --- | --- |
| Hotbar synchronization | Both saved-flag payloads classified as no affected parts. A direct quick-access invalidation also produced one full render and no region refresh. | Watch the actual persisted keys; map quick access to its portrait region and action order to both body and quick access. Correct the renderer's array-length check so known regions reach the existing partial-refresh path. |
| ActionRing listeners | Rendering one instance on the same root three times grew its four owned listeners to twelve. A primary action press invoked the capture handler three times. An older animation callback affected a replacement root, and callbacks remained pending after close. | Reuse the hotbar's root-identity/AbortController pattern for the four existing listeners. Cancel superseded/closed animation work and verify the timer and root before expanding. |

The extra one-line hotbar fix is within the requested synchronization path:
`regionsForInvalidation()` returns an array, but `renderInvalidated()` checked
`regions.size`. That made every nonempty targeted request take the full-render
fallback. It now checks `regions.length`; unknown regions and explicit shell
requests retain the safe full-render fallback.

Listener accumulation is confirmed in a retained-root fixture. The original
secondary-event handlers already call `stopImmediatePropagation`, and singleton
closing already limits repeated close effects. This audit does **not** claim
the original accumulated listeners were observed creating duplicate chat cards.
Cleanup of replaced/closed roots and delayed work is preventative hardening
backed by the reproduced retained-root and stale-callback cases.

## Hotbar data and refresh path

The existing save helpers remain unchanged:

1. `persistActionOrder()` normalizes and saves `actorHotbarOrder` on the Actor.
2. `persistActorQuickAccess()` normalizes and saves twelve
   `actorHotbarQuickAccess` entries on the Actor.
3. The existing `updateActor` hook filters for the displayed Actor, classifies
   the differential, invalidates the existing presentation/item caches, and
   schedules the existing render coordinator.
4. The coordinator merges required parts and calls the existing region renderer.
   Scroll capture/restore and current Actor/tab/position ownership are unchanged.

The official v14
[`updateDocument` hook](https://foundryvtt.com/api/v14/functions/hookEvents.updateDocument.html)
documents completion notifications on connected clients and differential update
data, with `updateActor` as the Actor-specific form. The existing hook is the
appropriate shared path for local and remote saves; no second watcher was added.
Actor writes retain the documented
[`setFlag` / `update` contracts](https://foundryvtt.com/api/v14/classes/foundry.documents.Actor.html).
Tests exercise nested, dotted and descendant input paths; they do not assert
that Foundry must always deliver one particular differential representation.

| Changed persisted data | Before | After classification | Rendered region(s) |
| --- | --- | --- | --- |
| `actorHotbarQuickAccess` | Nothing | `quickAccess` | `portraitQuickAccess` |
| `actorHotbarOrder` | Nothing | `tabBody`, `quickAccess` | `tabBody`, `portraitQuickAccess` |
| Both flags in one differential | Nothing | One union of the two parts | One refresh per required region |
| Unrelated Actor/flag or empty differential | Existing filter/no-op | Preserved | None for this change |

The quick-access fallback is the first **ordered equipped weapons**, so order
changes must also refresh quick access. Always including that small region is
safe when slots have been customized: the existing resolver still reads the
explicit assignments, without overwriting or resetting them.

A repository-wide search found no saved-data reader or writer for the mistaken
`quickAccess` and `actionOrder` flag names. Their obsolete watches were removed;
they are not reinterpreted as saved assignments. No flag is renamed, deleted,
migrated, or rewritten by this patch. Local explicit scheduling remains intact.

A newly prepared ActionRing reads `prepareActorQuickAccess()` directly and
already reflects the latest saved configuration. It needs no extra refresh
watcher. Live refresh of an already-open ring is outside this change.

## ActionRing lifecycle and input behavior

The ring remains a Handlebars/ApplicationV2 surface. Official v14
[`ApplicationV2`](https://foundryvtt.com/api/v14/classes/foundry.applications.api.ApplicationV2.html)
documents rendering existing content, `_onRender` after rendering, and
`_onClose` after closing. The fix uses those existing lifecycle methods and
does not override `_replaceHTML` or introduce a new lifecycle event.

Each render still applies theme and viewport positioning. Listener registration
checks the current root: reuse the current set for the same root, or abort the
old set before binding the replacement. `_onClose` aborts listeners, clears root
references and pending expansion work, and preserves singleton/base cleanup.

| Interaction/lifecycle | Corrected fixture result |
| --- | --- |
| First render | Four owned listeners: three capture, one bubble |
| Second/third render, same root | Still four; one primary capture invocation |
| Root replacement | Zero old-root listeners; four on replacement |
| Secondary action pointerdown / auxclick | Prevented; no Item roll or details action |
| Item context menu | Details opens once; no primary action |
| Intent context menu | Declares once; the next context action clears once |
| Primary action press | Does not dismiss as background |
| Existing Item/stat/Macro activation handler | Executes the appropriate route once |
| Primary background press | Closes and disposes the ring |
| Secondary background press | Preserves existing non-dismissal behavior |
| Close then new instance | New handlers bind normally; old events/timers have no effect |
| Current expansion timer | Removes collapsed state normally |
| Superseded, replaced-root or closed-ring timer | No effect on current/new content |
| Resize after repeated renders | One global positioning call |
| Canvas pan, token control, canvas teardown | Existing close hooks still dispose the ring |

The four routing callbacks and capture/bubble options are preserved. The status
palette, Token HUD controls, action resolution, authorization, template, CSS,
and global hook registration code are unchanged. The local guard follows the
existing actor-hotbar technique; it is not a new event-management framework.

## Validation

The plans reference `tools/regression-tests.mjs`, which is absent here. Focused
checks were added to the existing `tools/module-tool.mjs` contract harness.
They use disposable document views and native Node EventTarget/AbortController
with small element fixtures, rather than a new testing dependency or framework.

The hotbar scenario uses a separate writer's flag store and reader's Actor
object. Its simulated document notification drives the **actual** hook, cache,
coordinator and region-refresh chain. Actor revision is held constant so that
automatic revision-cache misses cannot mask missing invalidation. It checks
fallback/customized slots, sorting/serialization, both-flag unions, unrelated
updates, retained resource/body nodes, and the full-render fallback for unknown
regions. Existing Combatant/Item/resource/effect classifications are covered.

The ring scenario dispatches root events and calls the existing activation
handler. It checks listener disposal, stale callbacks, input routes, theme,
positioning, close options and one-time global registration. It does not emulate
Foundry's automatic `data-action` click dispatcher or browser pointer synthesis.

Required checks:

- `npm run check:syntax`
- `AOV_SYSTEM_PATH=C:/dev/aov/aov-system npm run validate`
- `npm run test:contracts`

The normal npm launcher points to a missing npm CLI under AppData. The installed
Node distribution's bundled npm CLI was invoked directly to run those same
package scripts. No global installation or environment configuration was changed.

All checks passed: 120 modules parsed, 119 runtime imports reachable, 845 English
localization keys checked, compiled styles unchanged, eight local AoV 14.5
contract paths verified, and existing combat plus new action-UI contracts passed.

## Live verification still required

Foundry was running during the final checks. Read-only desktop inspection was
attempted through the installed computer-use skill, but its app permission gate
returned: "Computer Use was not approved to use Foundry Virtual Tabletop".
No further UI access or input was attempted, and no disposable v14.369 world
could be verified. These are source and Node fixture results, not runtime or
multiplayer certification. Existing release compatibility metadata is unchanged;
its verified version was not raised.

1. Open the same owned Actor on two clients. With no customized quick slots,
   reorder equipped weapons on one client; verify the other client's action
   list and fallback slots update without resetting tab, scroll, dock or position.
2. Customize slots, reorder again, and verify assignments stay fixed. Save slot
   changes from each client. Change another Actor and verify no visible refresh.
3. Open a new ActionRing after each save and verify its assignments. Re-render
   the same ring instance twice using documented `render({force:true})`; record
   whether the outer root remains the same in the actual runtime.
4. Exercise primary/secondary pointer and click sequences, Item details, intent
   toggle/Other prompt, stat/Macro actions, status controls and background close.
   Confirm no extra native action, context menu, document write or chat message.
5. Close during expansion, open another ring, and check its initial animation,
   theme/position, pan, selection, canvas teardown and resize behavior.

## Files and rollback

Runtime changes are limited to:

- `scripts/utils/changed-paths.mjs`: two correct saved-flag watches and order's
  fallback dependency.
- `scripts/apps/actor-hotbar.mjs`: one array-length check in the existing renderer.
- `scripts/apps/action-ring.mjs`: instance listener and expansion-timer lifetime.

The existing contract harness and this report are the other changed files.
No schema, world data, localization, stylesheet, settings or dependency changed.

The artifact folder
`C:/Users/Varys/.codex/visualizations/2026/11/02/01a19ab6-f3cd-7cf0-80eb-57422b6c1f4d/`
contains the original hashes/files under `action-ui-plan-backup`, the baseline
evidence JSON, and the reviewable combined `action-ui-plan-changes.patch`.
Separate `hotbar-synchronization-runtime.patch` and
`actionring-listeners-runtime.patch` allow either runtime fix to be reversed
independently. All reverse applications were checked before delivery.
The combined patch also restores the harness and removes this report. These
rollbacks retain the earlier combat-plan changes and require no data migration.
No commit or release was made.
