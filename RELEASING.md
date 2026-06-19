# Release process

The repository publishes a complete Foundry VTT release whenever a semantic version tag is pushed. No personal access token or repository secret is required: the workflow uses the repository-scoped `GITHUB_TOKEN` with `contents: write`.

## 1. Set the new version

From the repository root:

```powershell
npm ci
npm run set-version -- 0.2.36
```

This updates `module.json`, `package.json`, `package-lock.json`, and `scripts/constants.mjs` together. Add the release notes to `README.md` before committing.

## 2. Validate the exact release contents

```powershell
npm run ci
npm run build
```

The installable files are generated in `dist/`:

- `aov-skjadlborg.zip` — the module archive installed by Foundry VTT
- `module.json` — the manifest asset used for installation and update checks
- `SHA256SUMS.txt` — checksums for both release assets

## 3. Commit, tag, and push

```powershell
git add .
git commit -m "Release v0.2.36"
git push origin main
git tag -a v0.2.36 -m "Age of Vikings - Skjadlborg v0.2.36"
git push origin v0.2.36
```

The tag must exactly match the version stored in the module: `v<module.json version>`. A mismatch fails before any release is published.

## 4. Automated result

`.github/workflows/release.yml` then:

1. runs all syntax checks and tests;
2. validates the manifest and release URLs;
3. creates a clean runtime-only archive;
4. verifies the ZIP;
5. creates the GitHub Release;
6. uploads `aov-skjadlborg.zip`, `module.json`, and `SHA256SUMS.txt`.

The permanent Foundry installation URL is:

```text
https://github.com/varys1337/aov-skjaldborg/releases/latest/download/module.json
```
