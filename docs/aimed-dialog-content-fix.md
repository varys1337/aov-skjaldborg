# Aimed-attack roll-options content fix

Implemented on 2026-11-02 after inspecting the supplied browser log
`localhost-1793620320042.log`.

## Cause and correction

The log reports `config.content element must have no attributes` while
constructing AoV's native roll-options dialog from
`AoVAdapter.#promptCoreRollOptions`.

The aimed branch created an HTML div and added the classes `aov-skjaldborg` and
`skj-core-attack-options` directly to that outer element. Foundry's official
[v14 DialogV2 documentation](https://foundryvtt.com/api/v14/classes/foundry.applications.api.DialogV2.html)
requires the outer content element to be a plain div. The root classes had no
stylesheet or listener consumers in this module.

The adapter now leaves the outer div attribute-free. Native form content and
the aimed summary remain children of that div. The fixed Attack selection,
additional modifier, submitted aim, and modifier calculation are unchanged.
The shared helper is used by both Attack and Missile workflows. Ordinary
non-aimed prompts still receive the existing template string.

This is one runtime-line removal plus a clarifying comment. No CSS, template,
document schema, setting, socket action, AoV system file, or compatibility
declaration changed.

## Verification and rollback

Static validation passed: 120 module files parsed, 119 runtime modules
reachable, 850 English localization keys, matching release CSS/SCSS, and eight
AoV 14.5 integration paths. Source comparison confirmed the runtime change is
limited to removing the content-root class assignment. The remaining aimed
content construction only modifies children of that div.

No test files were added and no automated test suites were executed. A live
Foundry retry was not performed. After loading the patched adapter, verify
that submitting an aimed Attack or Missile opens native roll options, preserves
the selected location, accepts an additional modifier, and cancels normally.
For the existing -20 penalty, an additional +10 should still contribute -10.

Pre-change copies and hashes are in `aimed-dialog-content-backup` in the task
artifact directory. The matching `aimed-dialog-content.patch` has passed a
reverse-application check without changing workspace files. Static validation
output and file hashes are preserved beside the patch.
