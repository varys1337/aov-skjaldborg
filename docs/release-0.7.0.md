# Skjaldborg 0.7.0 release verification

This release targets Foundry VTT 14.370+ and Age of Vikings 14.7+. Both
minimum/verified declarations use those versions under the selected automated
verification policy. Live gameplay has not been tested.

## Integration

Local validation uses the installed AoV 14.7 source, with `AOV_SYSTEM_PATH`
explicitly configured. CI and release builds use `cragstone/aov` commit
`08965ef0b2d95c806858542e7cfb036cf3014714` (tag `14.7`). The source contract
must pass before the release builder produces artifacts.

Actor and Item sheets continue to open through their native document sheets,
including AoV's image-editing flow. The initiative message-mode compatibility
patch and adjustment-dialog dismissal guard remain required by the inspected
AoV 14.7 implementation. Foundry UI references are the official v14
[ApplicationV2](https://foundryvtt.com/api/v14/classes/foundry.applications.api.ApplicationV2.html)
and [DialogV2](https://foundryvtt.com/api/v14/classes/foundry.applications.api.DialogV2.html)
documentation.

## Automated acceptance

The existing contract harness and retained regression suite cover version
rejection below the new minimums, native sheet delegation, dialog cancellation,
initiative behavior, movement deadlines and queue recovery, migration retries
and GM authority, serialized rendering, cache invalidation, local-write controls,
optional diagnostics, combat action claims, provenance, and read-only recovery.
No additional test source files were introduced.

The requested local `npm install` ran once in the Desktop checkout. A targeted
update of Sass's existing transitive `source-map-js` dependency to 1.2.2 resolved
the reported dependency advisory, with zero vulnerabilities reported afterward.
The direct dependency scope remains unchanged and all tooling stays outside the
runtime package.

Release CSS is compiled and compared with the source. Organization-only style
changes preserve the emitted cascade. Metadata, imports, templates, localization,
syntax, public facades, and socket contracts are checked by the existing tooling.

The canonical builder validates an optional tag against the package version and
produces `release/aov-skjaldborg.zip`, `release/module.json`, and
`release/SHA256SUMS.txt`. The ZIP retains its `aov-skjaldborg/` top-level folder.
Two consecutive builds must produce identical checksums. The embedded and
standalone manifests must match exactly, and development files and backups must
be absent from the archive. Published assets are downloaded and checked again.

## Remaining live checks

GM/player synchronization, dialog submission and resizing, movement execution,
hotbar interactions, overlays, and layout stability remain untested in a running
Foundry session. No measured runtime performance improvement is claimed. No live
world, installed AoV source, or Foundry configuration is changed by this release.

## Rollback evidence

Before editing, both working copies and their SHA-256 inventories were saved in
the development checkout's ignored `.maintenance/2026-11-05-v0.7.0/` directory,
along with the Desktop checkout's full starting commit. Earlier staged
maintenance rollback artifacts remain in `.maintenance/2026-11-04-cleanup/`.
The Desktop Git metadata, license, and release-tag hook are retained.
