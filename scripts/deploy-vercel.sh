#!/usr/bin/env bash
# scripts/deploy-vercel.sh — local pre-deploy wrapper for Vercel production deploys.
#
# WHY this exists: `.vercelignore` excludes `.git/`, so `git rev-parse HEAD`
# cannot run inside the Vercel build. The freshness proof requires the commit
# SHA to be captured locally and written to a static file BEFORE `vercel --prod`
# uploads the build context. This wrapper is the single canonical entrypoint —
# the owner runs `bash scripts/deploy-vercel.sh` instead of `vercel --prod`
# directly so scope and SHA capture are pinned in committed code.
#
# Sequence:
#   1. Write apps/static/version.json — the public freshness probe surface.
#      It carries the committed git SHA plus a source fingerprint when the tree
#      is dirty, so dirty prebuilt deploys do not masquerade as clean commits.
#   2. Upload through Vercel.
#      vercel.json rewrites /version.json → /static/version.json so the
#      checker fetches a clean URL.
#   3. Invoke `vercel --prod` pinned to the canonical project scope. The scope
#      flag is the only place this string is canonical — the freshness checker
#      no longer queries it because it fetches a public HTTPS URL instead.
#
# st_6f81e248 — deploy-freshness proof under the CLI deploy model.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RELEASE_SHA="$(git rev-parse HEAD)"
export ROBOTDOJO_RELEASE_SHA="$RELEASE_SHA"

node scripts/write-version-json.js
echo ""
DEPLOY_ARGS=(
  --prod
  --yes
  --build-env "ROBOTDOJO_RELEASE_SHA=${RELEASE_SHA}"
  --build-env "VERCEL_GIT_COMMIT_SHA=${RELEASE_SHA}"
  --meta "robotdojoReleaseSha=${RELEASE_SHA}"
)
if [[ -n "${ROBOTDOJO_VERCEL_SCOPE:-}" ]]; then
  echo "Deploying to Vercel (scope: ${ROBOTDOJO_VERCEL_SCOPE})..."
  vercel "${DEPLOY_ARGS[@]}" --scope "$ROBOTDOJO_VERCEL_SCOPE"
else
  echo "Deploying to Vercel..."
  vercel "${DEPLOY_ARGS[@]}"
fi

echo ""
echo "Pinging IndexNow (Bing, Yandex, Naver)..."
node scripts/submit-indexnow.js
