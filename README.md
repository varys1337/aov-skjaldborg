# Age of Vikings - Skjaldborg

Skjaldborg is a Foundry VTT v14 module for Age of Vikings combat workflow
automation, token action controls, and selected-actor hotbar support.


## Current Release: 0.3.0-alpha.24

- Narrows the Attack button footer column from 108px to 96px.
- Reduces the Base/Situation/Augment summary by approximately one pixel, from
  `0.75rem` to `0.6875rem`, and tightens its horizontal padding.
- Gives the modifier summary enough space to render its complete text at the
  compact 390px dialog width without changing attack behaviour or layout.

## Target Runtime

- Foundry VTT v14.363+
- Verified target: Foundry VTT v14.364 after live validation
- Age of Vikings system: `aov` 14.1

This branch is v14-only. The old portable v13 workflow is not used from this
checkout.

## Actor Hotbar Docking

- Click the narrow collapse control to collapse or expand the action panels.
- Drag that same control around the actor portrait to dock the action panels to
  the left, right, top, or bottom.
- The portrait remains the position anchor, the selected dock is stored as a
  client preference, and panel width is constrained to the available viewport.
- Right-drag the actor portrait to move the complete hotbar without changing
  the selected dock.

## Token Resources And Wellbeing

- The portrait resource pills follow the selected Token's configured `bar1` and
  `bar2` attributes. One configured bar is centred; two retain the paired layout.
- AoV HP and MP retain their system-specific update paths. HP is derived from
  the same Wound/Hit Location damage documents as the actor sheet; MP continues
  to show its available maximum and locked/total secondary state.
- The humanoid hit-location body map keeps the AoV 3-by-4 proportions and stays
  centred instead of stretching with a wide or vertically docked action panel.

## Source Of Truth

All development and production edits happen in:

```text
C:\dev\aov\aov-skjaldborg
```

The active local Foundry data path is:

```text
C:\Users\Varys\AppData\Local\FoundryVTT\Data
```

The installed AoV system at
`C:\Users\Varys\AppData\Local\FoundryVTT\Data\systems\aov` is read-only
reference material for this module.

## Style Build And Release Packaging

Foundry loads only compiled browser-ready CSS from:

```text
styles\skjaldborg.css
```

Edit source styles under:

```text
src\styles
```

Install the local build dependency once:

```powershell
npm install
```

Compile SCSS into the runtime stylesheet:

```powershell
npm run styles:build
```

Watch SCSS while developing UI changes:

```powershell
npm run styles:watch
```

Build the release-ready module folder:

```powershell
npm run build
```

Or use the PowerShell wrapper, which installs npm dependencies when needed,
compiles SCSS, builds the release folder, and validates the dist contents:

```powershell
.\build-dist.ps1
```

Upload or package the generated `dist\aov-skjaldborg` folder for release. The
release folder includes compiled CSS and runtime assets only; users do not need
Sass, npm, or the SCSS source.

## Validation

This repository intentionally has no `/tests` folder and no Node test suite.
Validate the module through live Foundry testing only.

Use:

```text
docs\manual-testing-live-foundry.md
```

In a loaded world, run:

```js
await game.aovSkjaldborg.diagnostics.run()
```

The diagnostics report confirms the v14 capability gate, AoV version, movement
API availability, socket availability, migration marker, and template loading.

## Architecture

- The module decorates AoV's combat tracker instead of replacing AoV combat
  classes or tracker classes.
- Combatant flags are authoritative for Skjaldborg workflow state.
- ActiveEffects mirror visible engagement status.
- Socket writes are GM-authoritative and include request ids.
- Movement execution uses public Foundry v14 movement APIs, preferring
  `Scene#moveTokens` for simultaneous checkpoint waves and falling back to
  `TokenDocument#move`.

## Historical Notes

Older release notes are kept in `previous-releases.md` for reference only.
