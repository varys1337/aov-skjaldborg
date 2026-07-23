## 0.6.0

- Adds a DialogV2 compatibility base (`SkjDialogV2`) to coalesce ApplicationV2 content refits and replaces direct DialogV2 subclasses to use it.
- Replaces legacy boolean `Application.render` signatures with option objects.
- Centralizes ChatMessage creation through module chat delivery helpers for background and interactive delivery.
- Adds version utilities for `compareVersions` / `versionAtLeast` handling.
- Hardens async paths with defensive promise catches and logger usage.
- Updates diagnostics and `module-tool` validation coverage for metadata and imports.

## 0.3.0-alpha.24

- Narrows the Attack button footer column from 108px to 96px.
- Reduces the modifier-summary font by approximately one pixel and tightens its
  spacing so the complete Base/Situation/Augment text remains visible at the
  390px dialog width.
- Leaves attack preparation, modifiers, targeting, damage modes, and hooks
  unchanged.

## 0.3.0-alpha.23

- Moves the Combat/Intent **Currently readied** label below the complete weapon
  control strip instead of above it.
- Preserves the existing 35px weapon-control stack and moves workflow pills one
  pixel lower so the label is fully visible without enlarging the tab.
- Increases the Attack Roll modifier-summary font by approximately two pixels
  for improved legibility at the compact 390px dialog width.

## 0.3.0-alpha.22

- Reduced the Attack Roll dialog width from 420px to 390px while preserving the existing two-column layout, full damage display, augmentation controls, and footer visibility.
- Restored the current readied-weapon label to normal flow directly above the weapon control strip.
- Redistributed Combat/Intent vertical spacing so the label is not cropped and the workflow pills remain within the existing tab boundary without increasing the HUD size.

# 0.3.0-alpha.21 Attack Roll stylesheet loading repair

- Repairs the unstyled, expanded Attack Roll dialog observed after the alpha.20
  stylesheet extraction.
- Keeps the Attack Roll CSS isolated in its own runtime file.
- Loads the resource explicitly at module evaluation and repeats the operation
  idempotently during `init`, using Foundry v14 route-prefix resolution and a
  cache-busted URL.
- Reduces the manifest back to the shared stylesheet entry; the dedicated file
  is now loaded by the module runtime rather than relying on a second manifest
  style link.
- Adds duplicate detection and a load-error warning without altering any attack
  form functionality.

# 0.3.0-alpha.20 compact summary, readied overlay, and CSS split

- Changes the Attack Roll modifier summary from a full-width footer field to a
  content-sized, center-aligned capsule with slightly smaller text and padding.
- Wraps the Combat/Intent weapon strip in a fixed 24px positioning context and
  layers the current readied-weapon label above it. The label remains bounded,
  uses ellipsis only for genuinely exceptional names, and no longer extends the
  tab or becomes cut by its lower frame.
- Moves the complete Attack Roll dialog style block into a dedicated runtime
  file.
- Registers the shared HUD stylesheet first and the dialog stylesheet second in
  `module.json`, retaining predictable cascade order and existing behaviour.

# 0.3.0-alpha.19 compact attack footer

- Changes the visible and DialogV2 default submit label from **Roll Attack** to
  **Attack**.
- Reduces the footer action column from 142px to 108px and tightens the button
  typography and padding.
- Gives the modifier-summary field the released width and reduces its font size
  from 0.73rem to 0.64rem so the complete Base, Situation, and Augment summary
  can render without ordinary truncation.
- Leaves attack preparation, form submission, and integration-hook payloads
  unchanged.

# 0.3.0-alpha.18 compact weapon row and enlarged target identity

- Moves the **Weapon** label onto the same row as its selector and reduces the
  selector to a fixed 214px content width.
- Prevents the weapon selector from visually crowding or overlapping the Attack
  percentage card while preserving native select behaviour.
- Enlarges the targeted Token portrait from 36px to 44px and increases the actor,
  target-label, and target-name typography within the existing header footprint.
- Leaves attack eligibility, damage-type selection, augmentation scaffolding,
  and integration-hook payloads unchanged.

# 0.3.0-alpha.17 full damage label and single tooltip

- Displays the effective localized damage name, RAW abbreviation, and formula
  together in the compact damage control.
- Keeps Cut-and-thrust attacks switchable between **Slashing [S]** and
  **Impaling [I]**, updating the visible label and downstream damage metadata.
- Removes the native `title` attribute and retains only Foundry's
  `data-tooltip`, preventing the browser and Foundry tooltips from appearing at
  the same time.
- Further narrows the Situation selector so the full damage label fits inside
  the unchanged 420px dialog.

# 0.3.0-alpha.16 immediate strike filtering and damage formula

- Restores the selected weapon's damage formula beside the effective RAW
  damage-type abbreviation in the compact modifier-row control.
- Keeps cut-and-thrust attack-mode selection scoped to the attack and displays
  the chosen effective `[S]` or `[I]` type alongside the formula.
- Narrows the Situation selector without increasing the dialog width.
- Limits immediate Attack options to the module-readied weapon, Hand-to-hand
  category attacks, and AoV `naturalWpn` Items. Carried but unreadied physical
  weapons remain available to the separate draw/readied workflow only.
- Resolves Hand-to-hand weapon-category CIDs through the AoV system when
  available and retains Fist/Kick/Grapple/name fallbacks for imported data.

# 0.3.0-alpha.15 attack-scoped damage mode

- Replaces the Attack Roll dialog's verbose Damage/type/formula display with a
  single compact RAW abbreviation and localized tooltip.
- Makes cut-and-thrust weapons declare Impaling or Slashing before rolling;
  clicking the damage-type pill toggles the per-attack mode without changing the
  owned weapon Item.
- Preserves the original weapon type separately from the selected effective
  damage type and builds downstream normal, special, and critical damage
  metadata that follows the AoV core system's `DM` roll contract.
- Adds damage-type-changed and prepare-attack-damage hooks for later chat-card,
  defence, and core damage integration.

# 0.3.0-alpha.14 target portrait and damage-type refinement

- Enlarges the target identity treatment inside the existing compact header and
  displays the targeted Token texture in a circular portrait without increasing
  the 420px dialog width.
- Narrows and centres the weapon selector and four augmentation pills to reduce
  unused horizontal spread while preserving the existing dialog structure.
- Reads the selected AoV weapon's `system.damType` and shows the RAW `C`, `CT`,
  `H`, `I`, or `S` abbreviation in the Damage pill with the localized full type
  available as a tooltip.
- Updates the live weapon preview and attack-request hook payload with damage and
  normalized damage-type metadata.

# 0.3.0-alpha.13 compact attack-roll dialog

- Reduces the Attack Roll window width from 520px to 420px.
- Scales typography, controls, cards, spacing, padding, radii, and footer
  elements down by approximately 20–25% without changing the dialog structure.
- Compacts the Foundry window header and preserves the responsive single-column
  fallback for narrow viewports.
- Leaves target validation, weapon/modifier previews, augmentation scaffolding,
  hook payloads, and right-click intent declaration unchanged.

# 0.3.0-alpha.12 attack-roll dialog scaffold

- Adds a custom Foundry v14 DialogV2 Attack Roll surface based on the supplied
  Mythras roll-dialog structure, restyled for the Skjaldborg AoV and Classic
  themes.
- Left-clicking Attack in the actor HUD Combat tab opens the dialog only when
  exactly one target is selected. Missing, multiple, invalid-target, and
  no-carried-weapon states produce explicit warnings.
- Defaults weapon selection to the currently readied weapon, then the first
  carried weapon, and provides live chance and damage previews.
- Adds Skill, Passion, Devotion, and Custom augmentation UI scaffolds without
  prematurely resolving those mechanics.
- Publishes a structured `aovSkjaldborgAttackRollRequested` hook payload for the
  later attack, defence, chat-card, and damage transaction workflow.
- Preserves right-click Attack intent declaration and canvas-marker behavior.

# Skjaldborg Release History

## 0.3.0-alpha.11

- Makes the existing Reactions workflow pill interactive without adding a new
  control frame: left click adds one reaction and right click removes one.
- Serializes reaction changes through the existing GM-authoritative socket and
  combatant write queue, with the counter clamped at zero by the authoritative
  handler.
- Reserves primary click on Combat-tab intent actions for future interaction
  workflows and emits the `aovSkjaldborgIntentAction` integration hook.
- Moves the prior Combat-tab declaration behavior to right click, including the
  custom Other-intent dialog and active-combat canvas marker creation.
- Leaves quick-access intent circles and the Token action ring on their existing
  primary-click behavior so their established interaction and removal gestures
  are not broken.

## 0.3.0-alpha.10

- Uses the selected Token disposition as the actor-HUD interaction accent for
  active tabs, selected intents, prepared actions, hover/focus states, and drop
  targets. Resource fills, wound severity, and workflow statuses keep their own
  semantic colours.
- Replaces AoV 14.1's deprecated `core.rollMode` read in
  `Combat#rollInitiative` with a v14-compatible implementation which preserves
  the system's existing initiative semantics and accepts `messageMode`.

## 0.3.0-alpha.8 authoritative HP and transparent empty wounds

- Derives the HP resource pill from the same owned Wound or Hit Location damage documents used by AoV actor preparation, preventing stale synthetic-Token HP values after embedded damage updates.
- Uses the same derived HP state when reconciling edits from the resource pill.
- Makes the Wounds panel body and empty-state message transparent when there are no active wounds, while retaining the normal section frame and header.

## 0.3.0-alpha.7 neutral hit-location AP/HP values

- Uses the standard HUD text colour for hit-location AP and HP values instead of inheriting the Token disposition palette.

## 0.3.0-alpha.6 final compact hit-location typography

- Reduced the hit-location name, roll range, AP/HP labels, and emphasized values by one additional pixel.
- Tightened the bounded card row heights, inter-column gap, letter spacing, and internal padding without changing card dimensions or body-map placement.
- Left wounds, resource bars, hit-location data, and interaction behavior unchanged.

## 0.3.0-alpha.5 compact hit-location typography

- Reduced body-map location-name, roll-range, AP and HP typography slightly so bounded cards no longer overflow or overlap.
- Tightened the lower value row and internal padding while preserving readable emphasis for AP/HP values.
- Kept the restored centred 3 × 4 hit-location arrangement unchanged.

## 0.3.0-alpha.4 token resource bars and hit-location alignment

- Uses Foundry v14 `TokenDocument#getBarAttribute` for the selected Token's configured `bar1` and `bar2` resource pills.
- Centres a single tracked resource and preserves the established paired layout for two tracked resources.
- Preserves AoV-specific HP wound reconciliation and MP available/locked/total handling.
- Bounds and centres the AoV 3-by-4 hit-location body map so larger panel widths do not distort card placement.

## 0.3.0-alpha.3

- Restored the action-header navigation icons to the stable centred layout in left, right, top, and bottom docking modes.
- Removed the nested horizontal scroll area from the header; active effects are right-aligned and clipped within their lane.
- Forced the top/bottom collapse rail to the same 10 px thickness as the left/right rail, overriding Foundry button minimum dimensions.
- Rebuilt History and Family → General Information as a standard read-only reference category containing only personal/header information; duplicate characteristic and short-attribute columns were removed.
- Added explicit Foundry v14 manifest `type` and `media` fields and corrected the distributable archive layout.

# Version 0.2.39 — Turnless Initial Planning

- Clears Foundry's initial active-turn assignment in the mutable `combatStart` payload whenever simultaneous live Planning is enabled. Round 1 now begins with no current Combatant, matching every later Planning phase.
- Leaves Foundry's normal first-combatant start intact when simultaneous Planning is disabled, the module is disabled, Planning is not the active configured phase, or the world is not using Age of Vikings.
- Retains the existing later-round reconciliation, which clears the cursor whenever the phase cycle re-enters Planning.

# Version 0.2.38 — Phase-Staged Movement DEX

- Keeps Planning initiative based only on the round reset, legal Planning actions, intent modifiers, and other direct DEX-rank changes. Banking or editing a planned route no longer deducts DEX.
- Applies movement DEX only after the authoritative movement run has finished and every route is terminal. Completed, stopped, and failed movement uses measured travelled distance rather than the originally planned path length.
- Re-ranks the AoV Combat Tracker at the end of Movement before the automatic transition to Resolution. Resolution queue construction remains a separate stage so later Resolution rules can extend the result without contaminating Planning.
- Marks module-owned Movement initiative projections so a hidden/immediate Movement run cannot be captured again as an external Planning adjustment.
- Clears the planned-distance cost on unavailable or failed zero-travel movement and preserves partial travelled distance when execution stops or fails after some checkpoints.

# Version 0.2.37 — Live Planning Initiative and Manual Turn Control

- Added a GM-only **Set Current Turn** command to the Combat Tracker participant context menu.
- Added the optional **Use simultaneous live initiative during Planning** world setting under Combat Tracking.
- In simultaneous Planning, the active-turn cursor is cleared, DEX/INT initiative remains live-sorted as legal Planning actions change DEX rank, and either Next Turn or Next Round advances the phase. Version 0.2.38 supersedes the original route-distance timing by applying movement cost only after actual travel.
- Preserved external AoV initiative deductions as explicit current-round Planning adjustments so later movement and Resolution calculations do not erase draw, sheathe, or other legal initiative changes.
- Retained the existing sequential Planning cursor when the new setting is disabled.
- Added serialized Planning initiative writes and phase-transition settling to prevent concurrent player updates from racing.

# 0.2.36 — Ranked phase chat cards

- Replaces the generic **Skjaldborg phase advanced** heading and separate phase line with one localized title in the form **Round N - Phase**. The Intent phase is now presented to users as **Planning**.
- Removes the redundant Resolution queue and simultaneous-group summary from phase reports; the ranked DEX table is the single phase-order presentation.
- Sorts every report table by Final DEX descending, then INT descending as the AoV tie-breaker, with deterministic name/id fallbacks.
- Adds INT to both Base DEX and Final DEX hover details so the ranking tie-breaker is visible without adding another table column.

# Age of Vikings - Skjaldborg

[![CI](https://github.com/varys1337/aov-skjaldborg/actions/workflows/ci.yml/badge.svg)](https://github.com/varys1337/aov-skjaldborg/actions/workflows/ci.yml)
[![Latest Release](https://img.shields.io/github/v/release/varys1337/aov-skjaldborg)](https://github.com/varys1337/aov-skjaldborg/releases/latest)

Foundry VTT module for full Age of Vikings combat-round workflow support.

## Installation

In Foundry VTT, open **Add-on Modules → Install Module**, paste the following manifest URL, and select **Install**:

```text
https://github.com/varys1337/aov-skjaldborg/releases/latest/download/module.json
```

For manual installation, download `aov-skjaldborg.zip` from the latest GitHub Release and extract it as `Data/modules/aov-skjaldborg`. The module folder name must remain identical to the manifest ID.

## Automated builds and releases

- Every push and pull request runs syntax checks, the complete test suite, manifest validation, and a clean packaging build. The resulting CI artifact is retained for 14 days.
- Pushing a matching semantic tag such as `v0.2.35` automatically creates a GitHub Release and uploads the installable ZIP, release manifest, and SHA-256 checksums.
- Version synchronization and the exact publishing commands are documented in [RELEASING.md](RELEASING.md).

Release 0.2.35 targets Foundry VTT v13.351 with Age of Vikings 13.29. Movement, status effects, Actor flags, dialogs, and Combat document workflows use documented v13 APIs.

This module is intentionally module-only. It decorates the existing Age of Vikings combat tracker and stores workflow state in module flags; it does not replace the AoV system combat classes or change actor/item schemas.

## 0.2.35 phase-control freedom and automatic Movement completion

- Fixes the AppV2 preset handlers in **Combat phase structure** by calling the class-owned persistence helper while retaining the clicked application instance for rerendering.
- Adds a GM-only **Combat tracking** submenu containing the optional all-intents gate, movement DEX rounding, movement checkpoint delay, and short/medium/long melee reach. The all-intents gate is now disabled by default and migrated off once for existing 0.2.34 worlds.
- Explicit phase-bar selections may jump to any enabled phase. Required crossed-phase automation still executes in canonical order, while unfinished movement drafts warn without trapping the GM in Statement.
- A visible Movement phase now remains active while every planned route executes, then automatically advances to the next configured phase—normally Resolution—instead of parking at the final initiative entry.
- Consolidates general and movement diagnostics under the single **Debug logging** checkbox. Enabling it activates every movement category at trace detail; the former movement-debug submenu is no longer registered.
- Removes the native `title` attribute from canvas intent markers so Foundry's `data-tooltip` is the only tooltip source.

## 0.2.34 configurable phases and tracker-native phase navigation

- Reinterprets Foundry's native **Next Round** Combat Tracker control as an explicit advance to the next configured Skjaldborg phase. **Next Turn** continues through the sorted combatant order and advances phase only after wrapping the final combatant.
- In 0.2.34, moved the tracker cursor to the final combatant after visible Movement; 0.2.35 supersedes this with automatic advancement to the next enabled phase after all routes finish.
- Adds a GM-only **Combat phase structure** world-settings submenu for Statement, Movement, Resolution, and Bookkeeping. The default remains the complete four-phase tactical round.
- Keeps disabled phases out of the tracker and Action HUD while preserving their automation at canonical boundaries: movement flushing, resolution-queue preparation, bookkeeping-ledger refresh, round archive/reset, and carryover application.
- Adds the optional **Streamlined Combat** preset with Resolution as the sole visible DEX countdown. Action declarations enter the queue immediately, routes execute when announced, and Bookkeeping is refreshed after outcomes through the `aovSkjaldborgImmediateBookkeeping` extension hook.
- Supports custom structures that omit Resolution: committed or held declarations enter the live queue immediately, and hidden Resolution boundaries preserve already resolved/skipped/carryover statuses instead of reopening them.
- Serializes immediate movement runs so a player route finalized during another streamlined route is executed in the next pass instead of remaining stranded in planned state.
- Retains the existing acknowledged player-to-GM movement persistence, route revision ordering, and one-checkpoint-per-tick movement scheduler.
- See `docs/phase-structure-and-navigation.md` for transition semantics and live validation.

## 0.2.33 player movement persistence and authority synchronization

- Adds request/acknowledgement semantics to the module socket. A player now receives **Movement plan captured** only after the active GM has validated ownership and completed the authoritative Combatant flag update.
- Serializes GM-side Combatant writes per Combatant. Rapid ruler-draft, final-route, cancellation, intent, and reaction requests can no longer perform concurrent read/merge/write operations against the same flag object.
- Re-evaluates movement route revisions inside the serialized write. An older `draft: true` request therefore cannot finish after and overwrite a newer finalized `draft: false` route.
- Adds an Intent-to-Movement synchronization barrier and a second execution-side settle check. Unfinished movement drafts block the phase transition with an explicit warning instead of being silently filtered from execution.
- Corrects remote ownership validation to use `TokenDocument#testUserPermission(user, "OWNER")` or Actor permission for the requesting User. The former `combatant.isOwner` check described the GM client running the socket handler, not the remote player.
- Rejects unknown socket senders and requires an actual GM requester for workflow-global controls such as phase advancement.
- Keeps the 0.2.25 authoritative Foundry route source and the existing one-checkpoint-per-tick scheduler unchanged.
- See `docs/player-movement-authority-fix.md` for the complete failure chain, API rationale, and live validation procedure.







## 0.2.32 Age of Vikings reaction accent

- Reactions tracker pills now use the Age of Vikings theme green through `--aov-title-font-colour`, with `#66b596` as a safe fallback.
- Defend remains blue, so defensive intent and reaction availability are visually distinct at a glance.
- No movement, scheduling, intent persistence, or tracker behavior was changed.

## 0.2.31 disposition-readable HUD labels and semantic tracker accents

- Compact table and segment headers inherit the represented combatant disposition: blue for friendly, high-contrast yellow for neutral, red for hostile, and muted grey for secret disposition.
- Primary group headings remain controlled by the selected HUD theme.
- A dark multi-direction text outline keeps small labels readable over bright maps while preserving the existing dimensions.
- Combat-tracker pills now use a coherent semantic accent system: action-specific intent colours, blue reactions, teal movement, amber equipment, violet timing/interrupt states, green remaining actions, and red danger/stopped states.
- The authoritative movement implementation remains unchanged.

## 0.2.30 reliable intent markers and disposition turn highlighting

- Active Actor HUD portrait borders now use friendly blue, neutral yellow, or hostile red according to the active Combatant Token disposition.
- Canvas intent markers follow Token animation and camera transforms through a low-cost PIXI ticker with change detection.
- Intent markers expose the selected action label through Foundry tooltips.
- Tracker intent pills are inserted before the native token-effects container so they remain close to the left-side encounter controls.

## 0.2.29 token intent markers and compact alignment

- Restores persistent circular intent markers above visible combat tokens. The markers reuse the exact Attack, Missile, Magic, Defend, Retreat, Knockback, Flee, Wait, Delay, and Other icons from the Combat Action HUD and are derived only from committed or held Combatant state.
- Keeps markers synchronized with combat state, token draw/refresh/destruction, canvas pan/zoom, scene changes, and combat creation/deletion without writing any movement or actor data.
- Prevents the readied-weapon tracker pill from flex-growing into spare row width and caps it at 72 px while retaining ellipsis and the complete tooltip.
- Aligns the collapse seam with the adjacent horizontal quick-access circle by accounting for the 38 px resource row before centering against the 192 px portrait stage.
- Leaves all movement capture, route, scheduler, and debug files unchanged.

## 0.2.28 intent-grid spacing and compact tracker pills

- Corrects the Action HUD intent-grid cascade mismatch: shared hotbar rules resolve each action button to 48 px while the grid previously reserved only 42 px per row. The grid now uses the resolved slot size and an 8 px row gap, preventing the two action rows from touching.
- Moves the weapon selector down with the corrected grid height and an additional conservative 2 px top margin.
- Reduces the Reactions tracker pill to its shield icon and penalty percentage. The full localized Reactions label remains available through the Foundry tooltip and accessible label.
- Keeps the Reactions, movement, and readied-weapon pills on one non-wrapping row. The weapon name may shrink and ellipsize, while its tooltip retains the complete name.
- Leaves all movement capture, route, scheduler, and debug files unchanged.

## 0.2.27 combat tracker and Action HUD geometry refinement

- Replaces the tracker text `Committed Attack`, `Committed Missile`, and similar combinations with the selected action name only. The commitment state remains available through the icon, CSS state, and tooltip.
- Allows the compact tracker intent pill to shrink and ellipsize long localized action names instead of pushing the initiative value beyond the combat tracker boundary.
- Increases the Action HUD intent-grid spacing from 4 px to 6 px in both axes, preventing adjacent button borders and active glows from visually colliding without materially enlarging the control block.
- Gives the right-side Action HUD panel a dedicated height based on the visible portrait stage and resource row. The scrollable tab body now ends at the same visual baseline as the left quick-access circle instead of inheriting the actor-core's reserved lower padding.
- Leaves all movement capture, route, scheduler, and debug files unchanged.

## 0.2.26 UI restoration and deployment reconciliation

- Consolidates the latest Action HUD implementation from the prior UI branch: the stable three-column AppV2 shell, draggable saved position, 6–12 shared quick-access circles, Statistics, History and Family, Skills, Magic, Equipment, optional Macros, editable HP/MP, XP toggles, theme selection, transparent portrait, collapse seam, and per-actor scroll memory.
- Restores compact combat-tracker intent indicators derived from existing persisted state: declared action category, movement plan, DEX modifiers, Delay/Wait, engagement, readied weapon, unresolved actions, and simultaneous-resolution membership.
- Keeps the compact four-icon phase row, status pill beside native controls, and one-line DEX/Move/Reactions metrics.
- Restores the module-owned Engaged SVG as the configured status-effect icon.
- Does not replace or edit the authoritative 0.2.25 waypoint capture, route selection, scheduler, or movement-debug implementation.

## 0.2.25 authoritative final route selection

- Uses `operation.movement[tokenId].waypoints` from the Foundry v13 `preMoveToken` update operation as the authoritative complete user-authored route.
- No longer treats `TokenMovementData.pending.waypoints` as a complete final route. During a multi-checkpoint drag it contains only the not-yet-passed section, while `movement.destination` can identify the checkpoint currently being processed rather than the route tail.
- Stores the last authored operation waypoint as the movement destination. This prevents the current checkpoint from being appended after the real route and eliminates the unintended return or post-route movement.
- Preserves the 0.2.24 live ruler banking and the one-checkpoint-per-tick movement scheduler.
- Adds compact final-route selection and completion-position diagnostics plus a regression case reconstructed from the affected live movement log.

## 0.2.24 authoritative waypoint banking and diagnostic capture

- Reads the documented Foundry v13 route from `TokenMovementData.pending.waypoints` before cancelling Intent-phase movement for banking. The compatibility normalizer also records passed and movement-history sections without allowing them to override the pending route.
- Observes `TokenRuler#refresh` and updates the Combatant's banked draft whenever the current user's explicit Ctrl-authored route changes. Draft plans are visible to the tracker but cannot execute until `preMoveToken` finalizes them.
- Merges the last ruler draft with the final `preMoveToken` route so an incomplete final operation cannot discard previously created corners.
- Orders asynchronous draft and final writes with monotonic route revisions. A delayed draft socket request cannot overwrite a newer finalized route.
- Treats `recordToken(document)` as a diagnostic notification only, matching its documented single-argument v13 signature instead of creating a competing movement write.
- Serializes movement diagnostics into the text of every console line. Saved browser logs now retain ruler data, raw movement and operation payloads, route candidates, revisions, socket persistence, scheduler state, and environment versions instead of collapsing objects to `{…}`.

## 0.2.23 multi-waypoint movement continuation

- Preserves ctrl-authored route waypoints from both the `preMoveToken` movement payload and its separate operation object before cancelling Statement-phase movement for storage.
- Executes exactly one expanded checkpoint in each authoritative `TokenDocument#move` call. The scheduler now owns continuation across every stored corner instead of submitting a whole segment and relying on core movement to resume after the first explicit waypoint.
- Keeps `TokenDocument#stopMovement` reserved for genuine interruption such as engagement or blocked movement; ordinary waypoint transitions are separate completed move operations.
- Adds regression coverage for multi-waypoint route data supplied through the hook operation object.


## 0.2.22 readied weapons and initiative automation

- Distinguishes AoV's carried, packed, and stored Item state from the one weapon the actor has actually drawn. The currently readied actor-owned weapon is persisted under a module Actor flag without changing the AoV Item schema.
- Uses only the currently readied carried weapon when calculating engagement reach. Other carried weapons no longer extend reach merely because they are available in the actor's inventory.
- Extends AoV 13.29's **Adjust Initiative** workflow with a selector containing only carried weapons. **Draw Weapon** readies the selected weapon and applies the existing 5 DEX adjustment; **Sheathe Weapon** clears it and applies the same adjustment.
- Adds the same Draw/Sheathe controls and current-weapon indicator to the actor action HUD. Readied weapons are highlighted in the Equipment tab, and packing or storing one clears stale readied state.
- Routes combat-time initiative and weapon changes through one GM-authoritative transaction and restores the prior readied weapon if the initiative update fails.

## 0.2.21 v13 engagement checkpoints and Engaged palette integration

- Executes planned movement one expanded grid checkpoint at a time and resolves reach before submitting the next checkpoint, so an engaged token cannot continue beyond the nearest applicable grid unit.
- Registers an `Engaged` status effect with a module-owned icon. The effect mirrors authoritative Combatant engagement state and stores combat, combatant, token, actor, partner, reach, and reason data under module flags.
- Preserves engagement across logical-round resets.
- Replaces consecutive calls to AoV's non-awaited `nextRound` override with one deterministic Combat update to the exact next Intent-compatible system round, while preserving AoV's initiative refresh.

## 0.2.19 movement engagement and weapon equipment

- Expands planned token routes into stoppable grid-step checkpoints and checks opposing reach after each authoritative movement update.
- Stops movement at the first applicable checkpoint, compares the currently readied melee weapon reach, and persists paired engagement state for both combatants.
- Adds actor-owned weapons to the Equipment tab with Combat-sheet percentage, damage, damage bonus, encumbrance, HP, status, and range fields.

## 0.2.18 initial AoV 13.29 movement bridge

- Sets the supported runtime to Foundry v13.351 with Age of Vikings 13.29.
- Uses the documented v13 movement path: route capture through `preMoveToken`, one-grid checkpoint execution through `TokenDocument#move`, and defensive interruption through `TokenDocument#stopMovement`.
- Registers Engaged in the v13 configured status catalog and creates it through `Actor#toggleStatusEffect` when available.

## 0.2.17 UI shell stabilization

- Keeps the header navigation, portrait column, workflow indicators, and right-side body on one fixed geometry while switching AppV2 tabs.
- Uses a dedicated compact grid seam for the collapse control instead of an absolute overlay.
- Keeps workflow pills in the actor column on every tab and removes the duplicate combat-body copy.
- Constrains every tab body to the configured action width and routes overflow into the existing body scroll regions.

## Action Ring And Actor Hotbar

Version 0.2.17 keeps the selected-actor hotbar on one fixed AppV2 tab shell, preserves the portrait/workflow column across every tab, compacts the collapse seam, and bounds all right-side bodies to the configured action width.

- The actor hotbar is a fixed viewport overlay with a dedicated drag handle. Its client position is persisted in the hidden `actorHotbarPosition` setting and can be reset from **Configure action interface**.
- The Combat tab contains only the ten Skjaldborg intent categories in a tighter five-column by two-row grid. Its fixed-height stage centers the intent controls while every tab keeps the same navigation origin. The portrait ring exposes 6 to 12 client-configured quick-access circles. Existing carried weapons remain as the initial compatibility fallback until the actor customizes the slots, and assignments outside the current visible count remain preserved.
- Skills are displayed as named, score-bearing controls grouped by AoV skill category in three compact desktop columns. Rune scripts, Seidur, and NPC powers use the same three-column layout by Item type. Passions and Devotions are grouped with History and Family in a dedicated sheet-derived tab. Right-click still opens the owned Item sheet and same-section drag ordering is preserved.
- The workflow indicators beneath the portrait use a deterministic two-by-two grid: phase and declaration status in the first column, final DEX and reactions in the second. The move handle follows the detailed-HUD control in the navigation row.
- The User Macros tab is rendered only when **Replace the core macro hotbar** is enabled.
- HP and MP are editable in place. MP updates `system.mp.value`. Character HP is reconciled through actor-owned Wound Items and NPC HP through `system.npcDmg` on actor-owned Hit Location Items because AoV derives `system.hp.value` from those documents during data preparation.

The module includes two frame-less ApplicationV2 surfaces adapted from the interaction model of Crucible Tongs without bundling Crucible system assets:

- The core Token HUD gains an action-ring control. The ring always mirrors the represented actor's configured quick-access actions in the same order and within the same 6 to 12 circle limit as the actor hotbar. Quick-access intent entries remain usable when the represented token is participating in an enabled Skjaldborg combat.
- Standard intent categories commit a clean default declaration through the existing GM-authoritative socket. Wait and Delay always open the detailed combat HUD because those declarations require extra data. Shift-click or right-click opens details for any intent.
- Multiple controlled tokens intentionally suppress the actor hotbar to prevent ambiguous rolls. A single controlled token, the assigned user character, or a player-owned character/NPC is used in that order.

The detailed combat HUD remains available from the Token HUD by right-clicking the action-ring control and from the gear button on the actor hotbar.

## Development Install

Run this from the module directory to link the workspace into Foundry's local module folder:

```powershell
.\tools\install-dev-link.ps1
```

The script creates `Data/modules/aov-skjaldborg` as a symbolic link or junction to this workspace. It refuses to overwrite an existing real module folder.

For a portable v13.351 test build, use copy mode when the source and Foundry data folders are on different drives:

```powershell
.\tools\install-dev-link.ps1 -FoundryDataPath F:\FVTT13\Data -InstallMode Copy -Replace
```

## Developer Checks

Use Node.js 20 or newer from the module directory:

```powershell
npm ci
npm run ci
npm run build
```

`npm run ci` performs syntax checks, runs every `tests/*.test.mjs` file, and validates the module manifest and release metadata. `npm run build` creates a runtime-only Foundry package in `dist/` without including tests, documentation sources, development tools, or `node_modules`.

Live Foundry verification is covered in [docs/manual-testing-live-foundry.md](docs/manual-testing-live-foundry.md).

## Phase Reports

The GM-facing AppV2 report submenu selects any combination of Statement, Movement, Resolution, and Bookkeeping entry reports. Reports default to a full all-combatant whisper for GMs. Public reports always contain all capable combatants. When player whispers are enabled, the module creates a separate player card whose DEX detail scope may include all capable combatants or only player-owned combatants. The player card remains a separate private message, and the module suppresses it from GM chat rendering so each audience sees only its own report card.


## 0.2.7 actor hotbar update

- Combat intent uses the actor-left/actions-right composition shown in the approved mockup.
- Workflow indicators move beneath the combat intent grid only on the Combat tab.
- Added a rollable Statistics tab for AoV characteristics, Status, and Reputation.
- Added a client-scoped actor hotbar resting-opacity setting from 0 to 100 in increments of 5.


## 0.2.8 actor hotbar visual alignment

- Removed the translucent container surface behind Statistics, Skills and Passions, Magic, and Macros while preserving the individual action controls.
- Restored the Combat navigation row to the same fixed origin used by every other tab.
- Prevented sparse Magic groups from stretching across the reserved stage; Rune Script, Seiðr, Devotion, and power groups now remain compact at the top like skill groups.




## 0.2.16 compact collapse, centered intents, and stable XP checks

- Reserves a dedicated seam for the collapse control so it no longer covers the first column of any active tab body.
- Vertically centers the collapse control against the complete expanded right-side surface.
- Derives the right-side tab height from the configured portrait-ring stage, preserving a common lower edge for 6 through 12 quick-access circles.
- Centers the navigation icons over the currently rendered tab body, independently of the active-effect strip.
- Makes the token action ring always resolve the actor's configured quick-access entries, including during Skjaldborg combat.

## 0.2.14 shared quick access, view-state persistence, and XP controls

- Reworks **Quick-access circles** into one client setting with a validated range of 6 to 12. The same count controls the portrait HUD and the out-of-combat token ring.
- Keeps a twelve-entry actor flag capacity so lowering the visible count never deletes hidden assignments.
- Makes the token ring resolve the actor's saved Item, statistic, intent, and Macro quick-access entries instead of rebuilding an unrelated list of actor Items.
- Uses a single dynamically sized radial circle for up to twelve actions rather than introducing a second concentric ring.
- Moves the collapse chevron into the vertical seam beside the portrait body, away from the tab header.
- Preserves the active AppV2 tab and per-tab scroll offsets across drag, collapse, expand, setting, and document-triggered rerenders.
- Adds direct XP check controls for Skill and Passion Items. The checkbox updates the owned Item and suppresses row drag start when clicked.

## 0.2.13 legibility, selectable theme, and compact mode

- Slightly increases hotbar text and label sizes while retaining fixed control heights, ellipsis handling, and bounded scroll regions.
- Adds a client-scoped visual-theme choice: **Age of Vikings** keeps the lightstone/darkstone surfaces, while **Classic** restores the earlier Crucible-style brown presentation.
- Keeps the actor portrait interior transparent in both themes.
- Adds a small collapse control beside the actor core. Collapsed mode hides the tab header, effects, and action content while leaving HP, MP, the portrait, quick-access slots, and workflow pills available.
- Collapse state is persisted per client and remains independent of actor data.

## 0.2.12 history, family, portrait drop, and AoV theme

- The central portrait becomes an explicit drag target while an internal hotbar action is being dragged. Dropping there assigns the action to the first empty quick-access slot; direct circle drops still replace or swap assignments.
- Statistics now mirrors the AoV Stats sheet with characteristic source columns, Reputation, Status, Species, Homeland, Social Rank, and Vadmal. Non-rollable values are informational and do not create a second editing path.
- Added a History and Family tab containing Passions, Devotions, History records, Family, Thralls, and Farms. Passions no longer appear in Skills and Devotions no longer appear in Magic.
- Non-transparent action controls use the AoV lightstone or darkstone chat-card texture and automatically follow Foundry light and dark themes.

## 0.2.11 quick-access visual refinement

- Empty portrait quick-access positions remain valid drop targets but are fully invisible while idle.
- The portrait ring uses a larger 192px stage and a 75px slot radius, keeping all six circles outside the portrait artwork.
- The actor core and action column share a deterministic bottom edge; workflow pills occupy the remaining lower space without overlapping the ring.
- HP and MP use a symmetric three-column value layout so the separator is centered within each resource card.

## 0.2.10 quick-access portrait ring

- HP and MP values are centered vertically and horizontally inside their editable resource cards.
- The six portrait circles are persistent actor quick-access slots stored in `flags.aov-skjaldborg.actorHotbarQuickAccess`.
- Drag an intent, statistic, skill, passion, magic item, equipment item, or user macro from the hotbar into any portrait slot.
- Dropping replaces the target assignment; dragging one occupied portrait slot onto another moves or swaps it.
- Right-clicking an occupied portrait slot removes that assignment.
- Actors without a saved quick-access configuration retain equipped weapons as a reversible compatibility fallback.

## 0.2.9 actor-hotbar refinement

- Aligns the tab-header row with the HP and MP cards on every tab.
- Reduces portrait equipment circles by roughly ten percent and adds clear spacing before workflow indicators.
- Adds an Equipment tab for actor-owned gear and armour, including quantity editing, equip-state cycling, and Item-sheet access.
- Keeps weapons out of the Equipment list. Before customization, equipped weapons fill the portrait quick-access slots as a compatibility fallback; afterward, saved slot assignments are authoritative.
