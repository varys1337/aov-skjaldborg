> [!WARNING]
> ## AI-Assisted Development Disclaimer
>
> This Foundry VTT module was developed with extensive AI assistance across implementation, code completion, refactoring suggestions, debugging, testing, and code-side review workflows.
>
> The author does not personally understand or cannot explain every component of the shipped codebase; nevertheless, full responsibility for all code included in this project, as well as its maintenance, is accepted by the author. Software execution was heavily AI-assisted, but package direction, architecture and code oversight, UX intent, and release responsibility were human-led. The author’s role in this project was primarily that of project lead and UX designer: defining the module's vision, directing the workflow, setting priorities, shaping feature scope, making high-level architectural decisions, and determining the user-experience design of the final module.

## Age of Vikings - Skjaldborg
An automated combat and QoL module for community implementation of Chaosium's Age of Vikings for Foundry VTT.

## Maintenance Notes
The current internal facade and workflow boundaries are documented in [docs/architecture.md](docs/architecture.md). Keep future refactors incremental, Foundry v14-focused, and compatible with existing module flags, settings, socket action names, and combat state fields.

Source validation is available through `npm run validate` and
`npm run test:contracts`. Create a deterministic local release artifact with
`npm run build`.

Set `AOV_SYSTEM_PATH` to the Age of Vikings system source directory before
validation or packaging. Standalone validation reports a skipped AoV contract
when the source is unavailable; release builds require that contract and stop
before changing build outputs if it cannot run. For example, in PowerShell:

```powershell
$env:AOV_SYSTEM_PATH = Join-Path $env:LOCALAPPDATA 'FoundryVTT\Data\systems\aov'
npm run validate
npm run test:contracts
```

If the local npm launcher is unavailable, the equivalent project entry points
are `node tools/module-tool.mjs validate`, `node tools/module-tool.mjs contracts`,
and `node tools/module-tool.mjs build`.

Version 0.7.0 requires Foundry VTT **14.370+** and Age of Vikings **14.7+**.
The minimum/verified declarations are 14.370 and 14.7 respectively, based on
source/API, contract, and packaging checks. **Live Foundry gameplay has not been
tested for this release.** Native AoV sheets retain their image-picker fixes;
Skjaldborg's combat workflows and saved schemas are preserved.

`npm run build -- --tag v0.7.0` validates the tag and creates
`release/aov-skjaldborg.zip`, `release/module.json`, and `release/SHA256SUMS.txt`.
The archive contains the `aov-skjaldborg/` directory. CI uses the pinned upstream
AoV 14.7 source and verifies reproducibility before publishing a tagged release.
The maintenance work is recorded in [docs/maintenance-cleanup.md](docs/maintenance-cleanup.md).

Licenses: All the code in this repository is licensed under the MIT License. Foundry VTT support is covered by the Limited License Agreement for Module Development. This system references trademarks and/or copyrights owned by Chaosium Inc/Moon Design Publications LLC, which are used under Chaosium Inc's Fan Material Policy. This module is not published, endorsed, or specifically approved by Chaosium Inc. For more information about Chaosium Inc's products, please visit www.chaosium.com. All rights are reserved with Chaosium Inc. Age of Vikings © copyright 1981–2025 Chaosium Inc.
