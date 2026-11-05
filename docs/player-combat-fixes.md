# Player combat interaction fixes

Implemented on 2026-11-02 for the three reported post-update issues.

## Intent confirmation in the widget

The Combat buttons use a dedicated ApplicationV2 action with `buttons: [0, 2]`.
Primary clicks retain the existing action behavior. Secondary clicks toggle the
declaration through `toggleIntentCategory`; Utility opens its existing dialog.
The widget's custom context-menu and auxiliary-click handlers let these controls
reach ApplicationV2. Secondary drag protection remains in place.

Before combat, declarations use the owned Actor's existing `preparedIntent`
flag. Active combat uses the existing GM-authoritative intent requests and
ownership validation. Successful writes invalidate the affected widget regions;
selection continues to come from document data. Write failures produce one
localized notification and release the pending-operation guard. Cancellation
does not produce an error.

The previous source-level player check succeeded before combat. It did not
reproduce the reported live failure. The event-routing change is implemented,
but resolution of the original player-client symptom still requires live
verification.

## Player initiative presentation

The restricted **Combat Tracking Settings → Navigation** form exposes the new
world Boolean `showPlayerInitiative`, labelled **Show initiative to players**.
It defaults to false.

- Enabled: players see read-only initiative scores and encounter order for the
  rows already rendered by the system. Numeric zero and negative scores are
  supported; unrolled initiative is left unnumbered.
- Disabled: those rows are sorted by their displayed names, with combatant ID
  as the stable tie-breaker. Initiative scores are hidden.
- Native initiative-roll controls and active-turn indicators remain available.
  GM presentation is unchanged.

The module does not create combatant rows or override the system's visibility
filtering. It changes DOM presentation only, without writing initiative or
sorting combat documents. Existing full-render and incremental-refresh paths
apply the presentation in the sidebar and its existing pop-out. Turning the
module off removes its presentation and restores native order.

This is a display setting, not a restriction on access to Combatant documents.

## Aimed attacks in the core dialog

When a submitted Skjaldborg payload supplies an aimed attack, the existing AoV
DialogV2 roll-options form receives a text summary of the selected body part or
weapon and the existing penalty. The core action offers only Attack and is
disabled. The modifier field is labelled **Additional modifier** and starts at
zero. The existing native field names are retained.

The aimed data is copied before opening the dialog so its summary and subsequent
attack use the same submitted choice. The calculation and aimed chat flags are
unchanged: the aimed penalty is applied once, and the additional modifier is
added once. A -20 aimed penalty with an additional +10 therefore contributes
-10. Attacks without a Skjaldborg aim retain the native action choices.

Target names are inserted as text. No AoV system files, combat schemas, or socket
action definitions were changed.

## Validation

The following development validation passed after implementation:

- Syntax: 120 module files parsed.
- Imports: 119 runtime modules reachable from `scripts/main.mjs`.
- Templates/localization: 850 English leaf keys checked.
- Styles: compressed release CSS matches SCSS.
- AoV integration: version 14.5, all eight existing contract paths present.

No test files were added and no automated test suites were executed.
The integration validator checks source paths and exports; it does not establish
live behavior in Foundry. Compatibility metadata remains unchanged
(minimum 14.363, verified 14.365); no v14.369+ certification is claimed.

Live acceptance remains pending:

| Area | Required checks |
| --- | --- |
| Player intent | Declare, change, and clear before and during combat; linked and unlinked tokens; repeated rendering and reopening; one write per interaction. |
| Intent permissions/failures | GM behavior; unowned actors rejected; failed Actor write or unavailable GM gives feedback and allows retry; Other cancellation is silent. |
| Existing controls | Primary actions, Utility, item context menus, quick-slot removal, and drag protection remain usable. |
| Initiative | Toggle both ways with player and GM connected; sidebar and pop-out; hidden combatants stay filtered; duplicate names; zero, negative, and unrolled scores. |
| Initiative refresh | Initiative changes, turn changes, row updates, encounter changes, and disabling the module retain the selected display policy. |
| Aimed attack | Body-part and equipment aims; summary and penalty agree with the submitted payload; extra +10 on a -20 aim contributes -10; cancellation produces no attack; ordinary attacks retain native options. |

## API references and rollback

The implementation uses the official v14 documentation for
[ApplicationV2 action buttons](https://foundryvtt.com/api/v14/interfaces/foundry.applications.types.ApplicationConfiguration.html),
[DialogV2 div content and input forms](https://foundryvtt.com/api/v14/classes/foundry.applications.api.DialogV2.html),
[CombatTracker views and pop-outs](https://foundryvtt.com/api/v14/classes/foundry.applications.sidebar.tabs.CombatTracker.html),
and [Combat turn order](https://foundryvtt.com/api/v14/classes/foundry.documents.Combat.html).

Pre-change copies and SHA-256 hashes are stored under
`C:/Users/Varys/.codex/visualizations/2026/11/02/01a19ab6-f3cd-7cf0-80eb-57422b6c1f4d/player-combat-fixes-backup`.
Restore the twelve files listed in its `manifest.json` to roll back this update.
No world-data migration is needed for either installation or rollback.
