# Releasing `@37signals/openclaw-basecamp`

This package is **not yet published** — `npm view @37signals/openclaw-basecamp`
returns 404. npm **trusted publishing (OIDC) requires the package to already
exist** before a trusted publisher can be configured, so the first publish is a
one-time manual bootstrap. Everything after it flows through
`.github/workflows/release.yml` on tag push.

The steps below are grouped by **who does them and when**. Do not collapse them:
the bootstrap publish creates the package but does **not** prove the CI pipeline
works — only the first *subsequent* version published through `release.yml`
does that.

## In this PR (code changes included here)

1. Publication metadata in `package.json`: `name`, `version`, `license`,
   `repository`, `publishConfig.access = "public"`.
2. Top-level `LICENSE` (MIT).
3. `release.yml` `publish` job pinned to **Node 24** (bundles npm ≥ 11.16, past
   the 11.5.1 that OIDC trusted publishing requires). The `test`/`security` jobs
   stay on Node 22.
4. `release.yml` `release-preflight` job — a hard, fail-closed gate that runs
   before `publish` (and is in `publish.needs`). On a tag push it reads the
   `release` environment via the API (`actions: read`, no `id-token`) and fails
   the release if the environment is missing, has no required reviewer, or has
   no deployment policy — so the OIDC-capable publish job never starts against
   an unprotected environment. Dry-runs (`workflow_dispatch`) skip the check.

## Post-merge bootstrap (maintainer / operator — a human, not CI)

Held under separate authorization. Do **not** run these as part of merging this PR.

5. **Create and protect the `release` GitHub environment** in repo settings,
   with **at least one required reviewer** and a **deployment policy restricted
   to `v*` tags**, **before any `v*` tag is pushed**.

   > ⚠️ A missing environment does **not** block the job. GitHub auto-creates a
   > referenced-but-missing environment on first use **without protection rules
   > or secrets** ([docs](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)),
   > so `environment: release` on the publish job is not itself a gate. The
   > `release-preflight` job (step 4) enforces this: on a tag push it fails the
   > release closed unless the environment exists with a required reviewer and a
   > deployment policy, before any credential is minted. Configuring the
   > environment as described here is what makes that gate pass — do not push a
   > `v*` tag until steps 5–7 are done.
6. **Authorized first publication** by a maintainer from a clean checkout at an
   exact reviewed commit SHA, after all gates pass. Run through `mise` so the
   pinned dev Node is used:

   ```bash
   mise install
   mise exec -- npm ci
   mise exec -- npm run check
   mise exec -- npm run build
   mise exec -- bash scripts/verify-pack.sh
   mise exec -- npm publish --access public   # granular automation token or 2FA
   ```

   This **only creates the package** on npm. It does not validate OIDC.
7. **Configure the npm trusted publisher** (GitHub Actions OIDC): this repo, the
   `release.yml` workflow, and the `release` environment. Verify with (needs
   **npm ≥ 11.5.1**, which the pinned dev Node ships):

   ```bash
   mise exec -- npm trust list
   ```

## Later release (first real OIDC proof)

8. Bump `package.json` `version`, tag `vX.Y.Z`, and push the tag. `release.yml`
   runs `release-preflight`, builds, runs `scripts/verify-pack.sh`, and
   publishes via OIDC with `--provenance`. **This tag-driven publish is the
   first real proof the OIDC pipeline works** — a green `workflow_dispatch`
   dry-run does not exercise authentication, and the bootstrap publish (step 6)
   only created the package.

## Notes

- `openclaw.plugin.json` also carries a `version` field, kept in sync with
  `package.json` manually. `release.yml` only checks `package.json` against the
  tag.
- The dev toolchain (`.mise.toml`) and the `publish` job both run on Node 24
  (latest LTS; bundles npm ≥ 11.16 for OIDC trusted publishing). The CI
  `test`/`security` jobs stay on Node 22 to exercise the package's runtime floor
  (`engines.node >= 22.5`).
