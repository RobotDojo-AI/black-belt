# Vercel deployment patterns

Production routes can fail post-deploy in ways localhost cannot catch. Source: st_a78848a0 (moved from CLAUDE.md to reduce always-loaded context).

## Three coordinated changes for any new public Vercel path

1. `middleware.js` `PASS_THROUGH_ROUTES` entry — without this, unauthenticated requests redirect to `/login`.
2. `vercel.json` rewrite to a concrete static file or function — without this the request falls back to `apps/index.html` (the marketing homepage).
3. Rewrite destination must respect `cleanUrls: true` — write `/static-file` (no `.html`), not `/static-file.html` — the `.html` form gets 308-redirected by the cleanUrls layer and may collide with the rewrite.

## Post-deploy smoke test

Every new path must include a `curl -skI https://robotdojo.ai/<path>` check covering status code, `location` header, AND body. A 200 with `content-length: 35000` is the marketing homepage being served as a fallback; a real route returns its actual content.

## Verification gap

A `curl -H "Authorization: Bearer $TOKEN"` criterion proves the Bearer path; it proves nothing about the cookie path. Plans for browser-reached routes must include at least one cookie-path verification — Bearer-only criteria are necessary but not sufficient.

Root cause for both lessons: st_42799dbe — `/auth/google/guidance` took 3 follow-up commits during post-deploy QA (PASS_THROUGH addition, then static-page extraction + rewrite, then cleanUrls correction). `routes/setup-steps.js` used route-level `requireAuth()` which broke browser cookie sessions despite Bearer tests passing.
