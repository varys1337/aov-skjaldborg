# Action-dialog layout refinement

Implemented on 2026-11-02 for Attack, Missile, Runic Magic, Utility, Knockback,
Grapple, Delay, Disengage, and Other Intent.

## Presentation changes

- Shared opening widths: 560 CSS pixels for the larger action forms and 520
  pixels for Knockback, Delay, and Other Intent. Opening widths are clamped to
  the viewport with a 16-pixel margin on either side.
- Content fills its window instead of imposing a second 390–400-pixel width.
  Window height remains automatic and is bounded by the viewport.
- Headers and primary actions remain outside the scrollable body. Existing
  form fields and submit buttons remain in their original form elements.
- Attack/Missile weapon controls share a compact row. Four-option groups and
  Utility tabs use one desktop row. Ammunition uses a normal labelled grid row.
- Runic Magic and Utility use horizontal portrait/identity headers and compact
  status cards. Script/DEX and paired equipment fields share rows when space
  permits. Utility no longer reserves empty panel height or nests a second
  scrolling shield-location list inside the main scrolling body.
- Footer spacing and action widths are consistent, with summaries on the left
  and the primary action on the right. Narrow layouts stack the footer.
- Container breakpoints use 30rem and 20rem: 480/320 pixels with normal 16-pixel
  text, adapting to larger text settings. Option groups use four, two, or one
  columns as space allows. Narrow modifier rows put damage/resistance notes on
  their own row. Label/result columns also accommodate enlarged text.
- Keyboard focus has an explicit two-pixel outline. Existing AoV and Classic
  colours and font sizes are retained.

The existing `SkjDialogV2.requestContentRefit()` remains the resizing path.
Utility tab changes now request that same coalesced refit. No observers,
additional hook registrations, or per-frame layout work were added at runtime.

Sizing presets and the viewport-aware opening-position helper are internal
exports next to the existing dialog base. No public game API, world setting,
document field, socket action, combat calculation, or migration changed.
The native AoV roll dialogs, settings, sheets, HUDs, and chat cards are outside
this update.

## Verification performed

Development validation passed:

- Syntax: 120 module files parsed.
- Imports: 119 runtime modules reachable from the entry point.
- Templates/localization: 850 English leaf keys checked.
- Release stylesheet: compiled CSS matches SCSS, 131781 bytes.
- AoV integration: version 14.5, eight existing contract paths checked.
- Source comparison: input names, action identifiers, and conditional-detail
  attributes are preserved in all eight Handlebars action templates.

No test files were added and no automated test suites were executed.

Standalone browser previews used the module's actual Handlebars templates, its
Disengage renderer, Foundry's installed stylesheet, and the compiled module CSS
with sample presentation data. These were inspected at 1366×768 and 1920×1080,
plus narrow widths and 150–200% text sizing. Sample default dimensions were:

| Dialog | Preview width × height |
| --- | --- |
| Attack | 560 × 313 |
| Missile | 560 × 353 |
| Runic Magic | 560 × 358 |
| Utility: Weapons | 560 × 275 |
| Knockback | 520 × 286 |
| Grapple | 560 × 393 |
| Delay | 520 × 244 |
| Other Intent | 520 × 246 |
| Disengage: eight opponents | 560 × 492 |

The inspected samples had no horizontal overflow. Narrow/expanded forms kept
the footer outside the scrolling body. All four Utility panels were inspected.
Expanded melee options were reviewed in Classic. A 328-pixel Runic form kept
two-column options; a 288-pixel expanded Attack form used one column and body
scrolling. Enlarged text caused controls to stack rather than overlap.

In the standalone preview, showing Custom increased Attack height from 313 to
353 pixels; hiding it restored 313. Reopening the field retained the entered
reason. Keyboard navigation to its numeric field showed a solid 2px outline.

Preview dimensions describe sample markup and a standalone frame, not a
guarantee of exact live Foundry window dimensions. The preview does not run
combat transactions or establish native ApplicationV2 lifecycle behaviour.

## Live Foundry acceptance still pending

Verify on an authorized Foundry v14.369+ client:

- Native window fitting, dragging, repeated opening, and expansion/collapse in
  both themes, including changing targets while a form is open.
- All Rune/Seiðr modes, Prepared/Resists/Craft/Custom combinations, warnings,
  long real script names, and forms with no available magic.
- Split/two-weapon controls, every augmentation combination, missing ammunition,
  long weapon names, and multiple targets.
- Utility shield-location selection and two-weapon allocation with real Items;
  long Disengage lists; both Delay modes; Other Intent submission/cancellation.
- Submission and cancellation continue to perform their existing operations.

Compatibility metadata remains unchanged; no new v14.369+ certification is
claimed from source checks or standalone previews.

## References and rollback

The existing refit path is supported by the official
[v14 ApplicationV2 API](https://foundryvtt.com/api/v14/classes/foundry.applications.api.ApplicationV2.html).
Existing [DialogV2](https://foundryvtt.com/api/v14/classes/foundry.applications.api.DialogV2.html)
input and prompt workflows are preserved.

Pre-change files and SHA-256 hashes are stored in
`C:/Users/Varys/.codex/visualizations/2026/11/02/01a19ab6-f3cd-7cf0-80eb-57422b6c1f4d/dialog-layout-backup`.
The adjacent `dialog-layout-refinement.patch` can be reverse-applied to restore
this update without reverting earlier combat fixes. No world-data migration is
required for installation or rollback.
