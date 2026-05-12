# FIX-1: Cloudflare Workers git-based deploy broken after build system v3 upgrade

## Symptom

Cloudflare Workers git-based auto-deployment fails at the "installing tools or
dependencies" stage with no actionable error message:

```
Detected the following tools from environment: npm@10.0.0, nodejs@22.16.0
Restoring from dependencies cache
Restoring from build output cache
Failed: error occurred while installing tools or dependencies
```

## Root cause

Two interacting issues:

### 1. `packageManager` version mismatch (build system v3)

Cloudflare migrated the build system from **v2** to **v3** in 2025-2026. The
v3 defaults changed:

| | v2 | v3 |
|-|----|----|
| Node.js | 18.17.1 | 22.16.0 |
| npm | 9.6.7 | 10.9.2 |

The project's root `package.json` declared `"packageManager": "npm@10.0.0"`.
Node.js 22 ships with Corepack, which enforces the `packageManager` field. The
mismatch between the declared `10.0.0` and the build image's `10.9.2` caused
Corepack to reject the installation.

### 2. Turborepo requires the `packageManager` field

Simply removing the field (the initial fix attempt) broke Turborepo:

```
x Could not resolve workspaces.
`-> Missing `packageManager` field in package.json
```

Turbo 2.x uses `packageManager` to detect which package manager runs the
workspace. Without it, `turbo run build` cannot resolve workspaces at all.

## Fix

Update the `packageManager` value to match the npm version that ships with
the v3 build system's Node.js 22.16.0:

```diff
- "packageManager": "npm@10.0.0",
+ "packageManager": "npm@10.9.2",
```

This satisfies both Corepack (version matches the build image) and Turborepo
(field is present).

## References

- Cloudflare Pages/Workers build system v3 migration:
  https://developers.cloudflare.com/pages/configuration/build-system/
- Corepack `packageManager` enforcement:
  https://nodejs.org/api/corepack.html
- Turborepo `packageManager` requirement:
  https://turbo.build/repo/docs/getting-started/installation
