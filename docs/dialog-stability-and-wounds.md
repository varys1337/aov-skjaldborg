# Action-dialog stability and widget wound refresh

Implemented on 2026-11-02 as an isolated follow-up to the dialog layout refinement.

## Changes

- Action-window sizing exposes the 11rem primary-action width on the window
  root. A shared footer grid owns that width; its button fills the action
  column. Narrow footers use one full-width column. Component-specific button
  widths and competing footer grids were removed. Button transitions cover
  colours and shadows rather than dimensions.
- Attack and Missile keep identity, targets, and weapon selection in the
  header. Their percentage cards occupy a 7.5rem column and fill the header's
  height. Stacked headers use a compact horizontal result row, including at
  enlarged text sizes, to leave room for the pinned footer.
- Split Attack and the conditional two-weapon control now sit beside a compact
  damage pill immediately before augmentation. Split allocation fields expand
  across the row below them. The full damage-type name remains available to
  assistive readers and in the existing localized tooltip; damage switching
  and live-preview selectors are preserved.
- Attack/Missile augmentation, Runic Magic options, and Utility tabs use two
  columns, with one column below 20rem of available content width. The existing
  560/520-pixel window presets, text sizes, themes, viewport limits, form paths,
  input names, action identifiers, and coalesced content refitting remain.
- The Item differential classifier now recognizes NPC `system.npcDmg` and the
  native wound/location fields consumed by the wellbeing view. These changes
  invalidate wellbeing and resource presentation through the existing Item
  hook and render coordinator. No extra listener or optimistic wound state was
  introduced. Adding, editing, or clearing NPC damage continues to update the
  existing Hit Location Item; it does not create or delete that location.
- Location frames and list accents share the existing theme-aware yellow,
  orange and red severity colours. The display takes the higher severity from
  active recorded injury effects and individual character Wound Items. It
  reuses `injurySeverity` from the combat tracker: a single wound at least
  1x / 2x / 3x location maximum HP displays yellow / orange / red. For example,
  a 33-point abdomen wound with 5 maximum location HP displays red even without
  a managed injury effect. Editing that Wound Item refreshes its display.
  Separate wound amounts are never combined to imply one severe blow. NPC
  aggregate damage alone cannot establish the 2x/3x single-blow thresholds;
  those still require a recorded effect. A location with positive maximum HP
  and current HP at or below zero retains the yellow fallback warning. No
  injury effect is created or modified by presentation; existing effects keep
  their lifecycle, including evidence of uncapped limb damage.
- Injury colour takes priority on a location border. Grapple/immobilization
  icons and secondary highlighting remain visible.

The supplied Game System damage rules distinguish location-HP thresholds and
single-blow consequences. Their colour mapping is the module's existing UI
convention. No damage calculation or consequence automation changed.

## Injury-colour follow-up (2026-11-03)

The previous effect-only display left manually entered severe wounds yellow.
The widget now reads the largest individual Wound Item per location during its
existing preparation pass and reuses the combat tracker's threshold helper.
The supplied Part 3, "Results of Damage", gives the 1x/2x/3x threshold groups;
Part 5 refers combat damage back to those rules. Colour remains a UI convention.
No injury effect, Wound Item, location HP or Actor HP is written by this change.

Installed AoV 14.7 `AOVDamage.addWound` confirms that character injuries create
separate Wound Items, whereas NPC damage is accumulated on the location. It
caps stored limb damage at 2x location HP. Consequently, recorded effects are
still needed to retain uncapped 3x limb evidence and NPC single-blow severity.

Direct preparation of disposable document data covered values just below and
at each threshold, the 33/5 example, separate small wounds, lower/higher
recorded effects, disabled effects, NPC aggregate damage and invalid maximum
HP. Actual prepared classes were previewed with the current stylesheet in light
and dark mode; label and border colours match for yellow, orange and red, and
list accents agree. No test files or automated test suites were added or run.
This verifies presentation against fixtures; live-world acceptance remains
pending as described below.

## Verification

Static validation passed: 120 module files parsed, 119 runtime modules
reachable, 850 English localization keys checked, release CSS matching SCSS,
and the existing eight AoV 14.5 integration paths present. The compiled release
stylesheet is 132907 bytes.

Source comparison confirmed that both rearranged templates retain their form
names, action identifiers, augmentation detail attributes, damage-preview
selectors, and split-field selector. No test files were added and no automated
test suites were executed.

Standalone browser previews used the updated Attack/Missile templates, the
unchanged remaining dialog sample markup, Foundry's installed stylesheet, and
the compiled module CSS. They do not instantiate Foundry applications or
perform document operations. Reviewed cases included:

- Desktop views at 1366x768 and 1920x1080, both themes, long weapon names,
  multiple targets, forced/available split states, and missing ammunition.
- Two-column option groups, all four Utility tabs, expanded augmentation and
  magic detail panels, and scrolling Disengage content.
- Narrow dialogs down to 288 pixels and 150-200% text sizes. The reviewed
  layouts had no horizontal overflow and kept primary actions visible. A
  footer-clipping case at 200% text was corrected with the compact result row.
- Normal desktop primary buttons measured 176 pixels and Attack/Missile result
  cards measured 120 pixels. Default Attack/Missile previews measured 560x383
  and 560x423 pixels respectively.
- Split expansion changed sample height from 383 to 436 pixels and back. An
  entered allocation of 70 survived collapse and reopening. Keyboard traversal
  reached the situation control with a visible two-pixel outline.
- Sample body-map cards showed matching label and border colours for all three
  severities, the unrecorded zero-HP warning, and combined grapple states.

## Live verification still required

No live Foundry session was controlled for this update. Confirm the initial
opening sequence in actual Attack, Missile, and Grapple applications before
marking the reported opening-time resize resolved. The stylesheet now provides
one deterministic action-width path, but the original live cause was not
confirmed in the standalone preview.

Also verify NPC add/edit/remove operations on linked and unlinked tokens, edits
from the actor sheet and another client, actor switching, document-derived
total/location HP, and injury-effect lifecycle updates. Full Rune/Seidr
behaviour, submissions, cancellation, real target refresh, and native content
refitting require a live session. Standalone visibility/scroll checks do not
establish those behaviours.

No public API, document schema, world setting, socket action, migration, core
AoV file, or compatibility declaration changed. Foundry v14.369+ live
compatibility remains unverified; existing manifest claims were retained.

## Rollback

Pre-change copies and SHA-256 hashes are preserved in
`dialog-stability-wounds-backup` under the task's artifact directory. The
matching `dialog-stability-wounds.patch` includes these changes and this audit.
Its reverse application was checked without changing the workspace. Preserve
later edits before reversing a patch or restoring the backup.

Browser observations, representative screenshots, and static validation output
are stored beside the patch. The preview is presentation evidence, not live
Foundry verification.
