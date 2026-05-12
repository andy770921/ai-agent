# FIX-1: Cloudflare deploy fix — implementation

## Changed file

### `package.json` (root)

Single-line change — update the `packageManager` version from `10.0.0` to
`10.9.2`:

```diff
 {
   "name": "openab-line-agent",
   "private": true,
   "version": "1.0.0",
   "description": "...",
-  "packageManager": "npm@10.0.0",
+  "packageManager": "npm@10.9.2",
   "workspaces": [
```

## Verification

Local build passes all three workspaces:

```
$ npm run build

 Tasks:    3 successful, 3 total
Cached:    0 cached, 3 total
  Time:    15.061s
```

After pushing, the Cloudflare Workers git-based auto-deployment should
complete successfully.
