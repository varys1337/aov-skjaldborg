# Compact Attack and Missile options

Implemented on 2026-11-02 to remove the empty space between Split Attack and
the damage pill.

## Layout

Situation, the existing weapon-mode controls, and damage now share one wrapping
row. The Situation field takes the available space; Split Attack and damage
remain content-sized with the shared small gap between controls. At the normal
560-pixel dialog width, the controls align on one centre line.

Below 30rem of content width, Situation takes its own row. The remaining mode
and damage controls stay adjacent and wrap when needed. This also accommodates
enlarged text without reducing the existing font size. Expanded split
allocations take the full width below the controls. Missile ammunition remains
a labelled field below this group.

The changes affect two templates and their existing presentation rules. Input
names, action identifiers, conditional fields, preview selectors, event
handlers, calculations, and form submission paths are preserved. The existing
two-column augmentation layout, percentage cards, footer sizing, themes,
window presets, and content-refit handling remain in use. There are no new
settings, document fields, migrations, API calls, or compatibility claims.

## Verification

- Static validation passed: 120 module files parsed, 119 runtime modules
  reachable, 850 English localization keys, and eight AoV 14.5 integration
  paths. Release CSS matches SCSS at 132971 bytes.
- Source comparison confirmed preservation of both templates' form names,
  action identifiers, augmentation attributes, and damage/split preview
  selectors. No test files were added or automated test suites executed.
- Standalone previews used the current Handlebars templates and compiled CSS,
  with preview navigation outside the dialog's height allocation. Desktop
  cases at 1366x768 and 1920x1080 showed matching control centre lines and
  six-pixel gaps at normal text size. Default dimensions were 560x347 for
  Attack and 560x387 for Missile, about 36 pixels shorter than the preceding
  layout at the same scale.
- Reviewed both themes, available/forced/unavailable split states, the
  two-weapon control, long weapon/target names, missing ammunition, expanded
  augmentation, 288/328-pixel windows, and 150-200% text sizes. The checked
  cases had visible primary actions and no horizontal overflow.
- A split allocation of 70 survived collapse and reopening. Sample height
  changed from 347 to 400 pixels when allocation fields expanded and returned
  to 347 pixels when collapsed.

The previews do not instantiate Foundry applications or execute combat rolls.
Live Foundry verification of dialog opening, submission, target refresh, and
native content refitting remains pending. Existing compatibility declarations
were retained.

Pre-change copies and hashes are in `compact-combat-options-backup` in the task
artifact directory. `compact-combat-options.patch` provides a reversible patch;
its reverse application was checked without changing workspace files. Browser
observations, screenshots, and static validation output are stored beside it.
