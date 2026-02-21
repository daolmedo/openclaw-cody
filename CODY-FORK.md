# openclaw-cody — Private Fork Guide

This is a private fork of the public [openclaw](https://github.com/openclaw/openclaw) project, maintained for [Cody](https://github.com/daolmedo/cody). It adds a `/api/usage` HTTP endpoint and an automated CI/CD pipeline that publishes a built package to S3 so Cody EC2 instances can install it at boot.

---

## What's different from upstream

| File | Change |
|------|--------|
| `src/gateway/usage-http.ts` | New — `GET /api/usage` endpoint |
| `src/gateway/server-http.ts` | +1 import, +handler call after the Slack handler |
| `.github/workflows/build.yml` | New — builds and uploads to S3 on every push to `main` |

### `/api/usage` endpoint

`GET /api/usage` (protected by the gateway auth token) returns month-to-date token and cost totals from OpenClaw's internal `loadCostUsageSummary`:

```json
{
  "ok": true,
  "period": { "start": "2026-02-01T00:00:00.000Z", "end": "2026-02-21T15:00:00.000Z" },
  "totals": {
    "input": 12000,
    "output": 4500,
    "cacheRead": 800,
    "cacheWrite": 200,
    "totalTokens": 17500,
    "totalCost": 0.0042,
    ...
  }
}
```

Cody's per-instance cron (`/usr/local/bin/cody-report-usage.sh`) calls this every 15 minutes, reports to the `codyusage` Lambda, and stops the gateway if the monthly cap is exceeded.

---

## Git remotes

```
origin    https://github.com/daolmedo/openclaw-cody.git  ← private fork (push here)
upstream  https://github.com/openclaw/openclaw.git       ← public openclaw (pull from here)
```

---

## CI/CD pipeline

Every push to `main` triggers `.github/workflows/build.yml`:

1. Installs dependencies with `pnpm` (version taken from `package.json` `packageManager` field)
2. Builds the UI (`pnpm ui:build`) and gateway (`pnpm build`)
3. Packs with `npm pack` → produces `openclaw-*.tgz`
4. Uploads to `s3://cody-openclaw-builds/openclaw-cody.tgz` with `public-read` ACL

The published artifact is always available at:
```
https://cody-openclaw-builds.s3.eu-west-2.amazonaws.com/openclaw-cody.tgz
```

Cody provisioner (`codyprovisioner` Lambda) references this URL in the EC2 user-data script. New instances install from it at boot.

### Required GitHub Actions secrets

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM user `cody-openclaw-ci` |
| `AWS_SECRET_ACCESS_KEY` | IAM user `cody-openclaw-ci` |

The IAM user has a single policy (`cody-openclaw-ci-s3`) with `s3:PutObject` + `s3:PutObjectAcl` on `arn:aws:s3:::cody-openclaw-builds/*` only.

---

## Syncing with upstream

When the public openclaw releases updates you want to pull in:

```bash
git fetch upstream
git merge upstream/main
# Re-check the three changed files above — resolve any conflicts
git push origin main   # triggers a new CI build automatically
```

If `server-http.ts` has changed upstream, make sure the `handleUsageHttpRequest` call is still present after the Slack handler block.

---

## Making changes to this fork

1. Edit files locally
2. `git push origin main` — CI builds and publishes to S3 automatically
3. New EC2 instances provisioned after the push will pick up the updated build
4. **Existing instances are not automatically updated** — they installed the build at boot time. To update a running instance, SSH in and re-run:
   ```bash
   curl -sf -o /tmp/openclaw-cody.tgz \
     https://cody-openclaw-builds.s3.eu-west-2.amazonaws.com/openclaw-cody.tgz
   npm install -g /tmp/openclaw-cody.tgz
   sudo -u ubuntu XDG_RUNTIME_DIR=/run/user/1000 \
     systemctl --user restart openclaw-gateway.service
   ```

---

## AWS infrastructure

| Resource | Value |
|----------|-------|
| S3 bucket | `cody-openclaw-builds` (eu-west-2) |
| IAM user | `cody-openclaw-ci` |
| IAM policy | `cody-openclaw-ci-s3` |
