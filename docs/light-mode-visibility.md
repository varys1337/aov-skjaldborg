# Light-mode visibility refinement

Implemented 2026-11-02. This is a presentation change; no document schema,
combat calculation, socket action, or core/system file is changed.

## Behaviour

- AoV uses light stone, dark text and teal accents in light mode. Classic uses
  warm ivory and brown. Both retain a dark palette.
- Actor HUD and ActionRing follow Foundry's **Interface** colour preference.
  Action dialogs and owned auxiliary prompts follow **Applications**.
- Theme selection remains the existing AoV/Classic setting. No setting is added.
- An empty core colour preference uses the resolved `--color-scheme` token from
  the Interface container or Application surface. An unresolved token leaves
  the current palette class intact. This CSS integration must be checked in
  the target live Foundry build.
- One feature-registered `clientSettingChanged` handler coalesces palette updates
  before the next paint. The AoV/Classic setting also updates open owned frames
  in place. Neither path rerenders forms or updates documents.
- HUD content groups, wellbeing sections, empty states and weapon controls have
  filled surfaces. Space around the portrait and action buttons stays transparent.
- Verified monochrome AoV default icons are inverted in light mode. Custom
  artwork and portraits are not filtered. The 18-image allowlist lives in the
  existing AoV integration contract.
- Injury text and frames retain yellow/ochre, orange and red categories with
  palette-specific contrast. Grapple/immobilization icons remain visible.
  Existing actor-sheet injury decoration keeps its original colour fallbacks.

The nine primary action dialogs and owned NPC-wound, initiative, grapple and
knockback prompts use the palette. Native AoV roll dialogs continue to inherit
their system styling. The attribute-free aimed-roll DialogV2 content wrapper
is unchanged. Width presets, typography, option grids, stable action widths,
input names and submission handlers are preserved.

## Verification

Static validation passes: 120 modules parse; 119 runtime modules are reachable;
850 English localization keys are checked; release CSS matches SCSS; and all
eight AoV 14.5 integration paths resolve. No automated test suite was run and no
test files were added.

Standalone browser review covered 43 recorded configurations at 1366×768 and
1920×1080, plus 300/360-pixel dialog widths and 150–200% text size. Fixtures use
current HUD templates, existing dialog presentation fixtures, installed Foundry
CSS, and the production theme helper with a small preview-only settings and
application registry. These checks are not a live Foundry runtime test.

- Reviewed all nine primary dialogs in both light palettes, auxiliary prompts,
  all HUD tabs, ActionRing, representative dark palettes and mixed preferences.
- No outer-window horizontal overflow or hidden primary footer was observed.
- Selected palette text pairs measure at least 4.66:1; tested field-boundary
  pairs measure at least 3.76:1. These are semantic palette calculations, not
  a claim that every state, texture or user-selected HUD opacity was audited.
  Disabled controls retain their existing visual treatment.
- Changing palette in an expanded Attack fixture preserved reason text, the
  additional value, all four expanded options, the 560-pixel window width and
  the 176-pixel primary button width.
- Before/after screenshots cover Missile and HUD skills. Additional screenshots
  show Classic, wellbeing, combat controls and ActionRing over a busy background.

**Live Foundry v14.369+ verification remains unavailable.** Verify initial frame
colour, actual core preference changes (including empty/resolved preferences),
all magic modes and auxiliary prompts, module interactions, and keyboard/focus
and scroll retention in a real player/GM session. Compatibility metadata has
not been increased.

## Reversal and evidence

Artifacts are under:

`C:/Users/Varys/.codex/visualizations/2026/11/02/01a19ab6-f3cd-7cf0-80eb-57422b6c1f4d/`

- `light-mode-backup/manifest.json`: pre-change files and SHA-256 hashes.
- `light-mode-visibility.patch`: reversible patch, including release CSS.
- `light-mode-evidence.json`: changed files, hashes and static verification.
- `light-mode-browser-observations.json`: recorded browser configurations.
- `light-mode-validation.txt`: static validation output.
- `light-mode-*.png`: presentation comparison images.

From the module directory, check reversal before applying it:

```powershell
git apply --reverse --check "C:/Users/Varys/.codex/visualizations/2026/11/02/01a19ab6-f3cd-7cf0-80eb-57422b6c1f4d/light-mode-visibility.patch"
git apply --reverse "C:/Users/Varys/.codex/visualizations/2026/11/02/01a19ab6-f3cd-7cf0-80eb-57422b6c1f4d/light-mode-visibility.patch"
```

The check protects later edits from an incompatible reversal. The original
files remain in the backup if a manual comparison is needed.

## Official API references

- [GameUIConfiguration](https://foundryvtt.com/api/v14/interfaces/foundry.GameUIConfiguration.html)
- [ClientSettings](https://foundryvtt.com/api/v14/classes/foundry.helpers.ClientSettings.html)
- [clientSettingChanged](https://foundryvtt.com/api/v14/functions/hookEvents.clientSettingChanged.html)
- [ApplicationV2](https://foundryvtt.com/api/v14/classes/foundry.applications.api.ApplicationV2.html)

The registered `core.uiConfig` key and resolved CSS token were checked against
the installed core configuration/styles. Only documented settings, hook and
ApplicationV2 interfaces are used; no private core method is replaced.
