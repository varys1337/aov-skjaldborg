# Maintenance cleanup audit

Date: 2026-11-04. Source version: 0.6.0. Implementation target: Foundry 14.369+.

Historical audit: the subsequent 0.7.0 release raises the minimum/verified
declarations to Foundry 14.370 and AoV 14.7 under the explicitly selected
automated-only verification policy. See `previous-releases.md` for current
release scope and packaging; the original cleanup evidence below is retained.

This is an automated/source verification report, not live Foundry certification.
The workspace has no usable Git history. No release was published, no live world
was changed, and the machine's npm installation was left untouched.

## Delivered changes

1. Movement write settlement now bounds unresolved writes by the remaining
   deadline. Timeout preserves the queue and returns the existing pending-plans
   warning; movement/phase/socket callers stop subsequent progression.
2. World migrations run on the selected authoritative GM. Completion markers
   follow required writes. Debug migration saves the combined enabled value
   before clearing its legacy switch, preserving retry safety.
3. Render requests share one asynchronous drain. Invalidations received during
   a render remain queued for a following batch. Failures are isolated by surface,
   and manual flushing cancels its redundant scheduled frame. All merged reasons,
   regions, identifiers, and full-render precedence are retained.
4. Async presentation builds share work within an actor/category generation.
   Invalidated or superseded completions cannot restore stale cache entries;
   failed builds remain retryable. XP and preparation controls keep document-hook
   invalidation active and clear disabled/busy state after failures as well as success.
5. Disabled diagnostics skip detail factories and render-detail serialization.
   Measurement completion removes its pending mark even after diagnostics are disabled.
6. Ring/hotbar dialog launchers share one owner with existing hotbar re-exports.
   Route cleaning/merging lives in the existing route module with controller
   re-exports. Combat execution and engagement decisions retain their owners.
7. SCSS is grouped by its owning surface, preserving the exact emitted cascade.
   Validation and packaging helpers were extracted from the command runner;
   the existing contract harness and command names remain in place. Release
   builds require the AoV source contract before changing generated outputs.

Module identity, version/compatibility declarations, settings keys, socket action
names, saved schemas, gameplay rules, action claims, provenance, and the read-only
recovery safeguards are preserved. No migration version was incremented.

## Automated verification

- Validation: 128 JavaScript modules parse; all 124 runtime modules are reachable;
  metadata, templates, 954 English localization leaves, and stylesheet checks pass.
- AoV source contract: neighboring `aov-system` reports 14.5; all eight integration
  paths and the checked exports pass. This does not identify a running world's version.
- Existing contracts pass, including added regression cases for bounded waits,
  pending-plan phase blocking, queue recovery, migration failure/retry, two-GM
  authority, and per-user client migration.
- Render/cache/diagnostic contracts cover overlapping flushes, invalidation during
  rendering, failure isolation, merged reasons/regions, concurrent reads,
  invalidation during builds, rejection/retry, disabled factories, and mid-operation
  disabling. Control contracts cover XP/preparation success/failure and unrelated
  document updates during pending writes.
- Launcher contracts preserve context identity and cancellation for all eight
  launchers. Route fixtures preserve ordered corners and non-consecutive repeats.
- Packaging contracts compare two archives byte-for-byte, decompress and compare
  every runtime entry, and reject development-only content. A missing-AoV release
  build is rejected without changing existing `dist` or `release` artifacts.
- The compressed Sass output before/after style organization is byte-for-byte
  identical. The checked-in runtime CSS is unchanged from the rollback baseline.

Checks use the project's direct Node entry points because the local npm launcher
cannot locate its npm CLI. No new test source files were created. Archive fixtures
are temporary and removed after verification.

## Rollback

Local, ignored artifacts are under `.maintenance/2026-11-04-cleanup/`:

| Artifact | Purpose |
| --- | --- |
| `baseline/` and `baseline-sha256.json` | Original source copies and SHA-256 inventory |
| `stage-01.patch` | Movement deadlines, callers, migration sequencing, initial contracts |
| `stage-02.patch` | Render/cache/diagnostic safety and hotbar controls, contracts |
| `stage-03.patch` | Shared launchers and route helpers, facade contracts |
| `stage-04.patch` | SCSS organization with identical emitted CSS |
| `stage-05.patch` | Tooling split, packaging checks, documentation |
| `verification.json` | Changed-path inventory and byte-for-byte rollback/reapplication proof |

Each stage also has a source snapshot. Apply patches in ascending order to the
baseline; reverse them in descending order for rollback. Back up any subsequent
user changes before restoring source. Rollback does not rewrite world data.
The five patches were reversed to all 200 original files and reapplied to all
207 final files in an isolated copy, comparing every file by SHA-256.
Use explicit line-ending options so local Git configuration cannot convert files:

```powershell
git -c core.autocrlf=false -c core.eol=lf apply --reverse .maintenance/2026-11-04-cleanup/stage-05.patch
```

Continue with stages 04 through 01 for full rollback. The original source copies
and hash inventory remain available independently of Git.

## Remaining runtime checks

Verify in Foundry 14.369+ with GM and player clients: startup and settings,
movement planning/execution and pending-plan warnings, phase navigation, dialog
submission/refitting, XP and preparation controls, hotbar synchronization, overlays,
and light/dark layouts with stable scroll regions. Check performance using the
existing opt-in diagnostics; no measured runtime speed gain is asserted here.

Change minimum/verified compatibility metadata together only after that separate
runtime verification. Forced-movement rules, automated range interpretation,
new recovery actions, and deletion of competing CSS overrides remain outside
this maintenance cleanup.
