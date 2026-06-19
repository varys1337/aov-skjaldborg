# Age of Vikings - Skjadlborg

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
- Adds the optional **Streamlined Combat** preset with Resolution as the sole visible DEX countdown. Action declarations enter the queue immediately, routes execute when announced, and Bookkeeping is refreshed after outcomes through the `aovSkjadlborgImmediateBookkeeping` extension hook.
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
- The actor hotbar is a fixed viewport overlay with a dedicated drag handle. Its client position is persisted in the hidden `actorHotbarPosition` setting and can be reset from **Configure action interface**.
- The Combat tab contains only the ten Skjaldborg intent categories in a tighter five-column by two-row grid. Its fixed-height stage centers the intent controls while every tab keeps the same navigation origin. The portrait ring exposes 6 to 12 client-configured quick-access circles. Existing carried weapons remain as the initial compatibility fallback until the actor customizes the slots, and assignments outside the current visible count remain preserved.
- Skills are displayed as named, score-bearing controls grouped by AoV skill category in three compact desktop columns. Rune scripts, Seidur, and NPC powers use the same three-column layout by Item type. Passions and Devotions are grouped with History and Family in a dedicated sheet-derived tab. Right-click still opens the owned Item sheet and same-section drag ordering is preserved.
- The workflow indicators beneath the portrait use a deterministic two-by-two grid: phase and declaration status in the first column, final DEX and reactions in the second. The move handle follows the detailed-HUD control in the navigation row.
- The User Macros tab is rendered only when **Replace the core macro hotbar** is enabled.
- HP and MP are editable in place. MP updates `system.mp.value`. Character HP is reconciled through actor-owned Wound Items and NPC HP through `system.npcDmg` on actor-owned Hit Location Items because AoV derives `system.hp.value` from those documents during data preparation.
- The core Token HUD gains an action-ring control. The ring always mirrors the represented actor's configured quick-access actions in the same order and within the same 6 to 12 circle limit as the actor hotbar. Quick-access intent entries remain usable when the represented token is participating in an enabled Skjaldborg combat.
- Standard intent categories commit a clean default declaration through the existing GM-authoritative socket. Wait and Delay always open the detailed combat HUD because those declarations require extra data. Shift-click or right-click opens details for any intent.
- Multiple controlled tokens intentionally suppress the actor hotbar to prevent ambiguous rolls. A single controlled token, the assigned user character, or a player-owned character/NPC is used in that order.
- The detailed combat HUD remains available from the Token HUD by right-clicking the action-ring control and from the gear button on the actor hotbar.

## 0.2.16 actor hotbar update

- Combat intent uses the actor-left/actions-right composition shown in the approved mockup.
- Workflow indicators move beneath the combat intent grid only on the Combat tab.
- Added a rollable Statistics tab for AoV characteristics, Status, and Reputation.
- Added a client-scoped actor hotbar resting-opacity setting from 0 to 100 in increments of 5.


## 0.2.15 actor hotbar visual alignment

- Removed the translucent container surface behind Statistics, Skills and Passions, Magic, and Macros while preserving the individual action controls.
- Restored the Combat navigation row to the same fixed origin used by every other tab.
- Prevented sparse Magic groups from stretching across the reserved stage; Rune Script, Seiðr, Devotion, and power groups now remain compact at the top like skill groups.




## 0.2.14 compact collapse, centered intents, and stable XP checks

- Reserves a dedicated seam for the collapse control so it no longer covers the first column of any active tab body.
- Vertically centers the collapse control against the complete expanded right-side surface.
- Derives the right-side tab height from the configured portrait-ring stage, preserving a common lower edge for 6 through 12 quick-access circles.
- Centers the navigation icons over the currently rendered tab body, independently of the active-effect strip.
- Makes the token action ring always resolve the actor's configured quick-access entries, including during Skjaldborg combat.

## 0.2.13 shared quick access, view-state persistence, and XP controls

- Reworks **Quick-access circles** into one client setting with a validated range of 6 to 12. The same count controls the portrait HUD and the out-of-combat token ring.
- Keeps a twelve-entry actor flag capacity so lowering the visible count never deletes hidden assignments.
- Makes the token ring resolve the actor's saved Item, statistic, intent, and Macro quick-access entries instead of rebuilding an unrelated list of actor Items.
- Uses a single dynamically sized radial circle for up to twelve actions rather than introducing a second concentric ring.
- Moves the collapse chevron into the vertical seam beside the portrait body, away from the tab header.
- Preserves the active AppV2 tab and per-tab scroll offsets across drag, collapse, expand, setting, and document-triggered rerenders.
- Adds direct XP check controls for Skill and Passion Items. The checkbox updates the owned Item and suppresses row drag start when clicked.

## 0.2.12 legibility, selectable theme, and compact mode

- Slightly increases hotbar text and label sizes while retaining fixed control heights, ellipsis handling, and bounded scroll regions.
- Adds a client-scoped visual-theme choice: **Age of Vikings** keeps the lightstone/darkstone surfaces, while **Classic** restores the earlier Crucible-style brown presentation.
- Keeps the actor portrait interior transparent in both themes.
- Adds a small collapse control beside the actor core. Collapsed mode hides the tab header, effects, and action content while leaving HP, MP, the portrait, quick-access slots, and workflow pills available.
- Collapse state is persisted per client and remains independent of actor data.

## 0.2.11 history, family, portrait drop, and AoV theme

- The central portrait becomes an explicit drag target while an internal hotbar action is being dragged. Dropping there assigns the action to the first empty quick-access slot; direct circle drops still replace or swap assignments.
- Statistics now mirrors the AoV Stats sheet with characteristic source columns, Reputation, Status, Species, Homeland, Social Rank, and Vadmal. Non-rollable values are informational and do not create a second editing path.
- Added a History and Family tab containing Passions, Devotions, History records, Family, Thralls, and Farms. Passions no longer appear in Skills and Devotions no longer appear in Magic.
- Non-transparent action controls use the AoV lightstone or darkstone chat-card texture and automatically follow Foundry light and dark themes.

## 0.2.10 quick-access visual refinement

- Empty portrait quick-access positions remain valid drop targets but are fully invisible while idle.
- The portrait ring uses a larger 192px stage and a 75px slot radius, keeping all six circles outside the portrait artwork.
- The actor core and action column share a deterministic bottom edge; workflow pills occupy the remaining lower space without overlapping the ring.
- HP and MP use a symmetric three-column value layout so the separator is centered within each resource card.

## 0.2.01 quick-access portrait ring

- HP and MP values are centered vertically and horizontally inside their editable resource cards.
- The six portrait circles are persistent actor quick-access slots stored in `flags.aov-skjadlborg.actorHotbarQuickAccess`.
- Drag an intent, statistic, skill, passion, magic item, equipment item, or user macro from the hotbar into any portrait slot.
- Dropping replaces the target assignment; dragging one occupied portrait slot onto another moves or swaps it.
- Right-clicking an occupied portrait slot removes that assignment.
- Actors without a saved quick-access configuration retain equipped weapons as a reversible compatibility fallback.

## 0.2.00 actor-hotbar refinement

- Aligns the tab-header row with the HP and MP cards on every tab.
- Reduces portrait equipment circles by roughly ten percent and adds clear spacing before workflow indicators.
- Adds an Equipment tab for actor-owned gear and armour, including quantity editing, equip-state cycling, and Item-sheet access.
- Keeps weapons out of the Equipment list. Before customization, equipped weapons fill the portrait quick-access slots as a compatibility fallback; afterward, saved slot assignments are authoritative.
