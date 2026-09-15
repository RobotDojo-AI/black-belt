# Analytics — Robot Dojo Marketing

GA4 (gtag.js) + Microsoft Clarity are loaded by `/static/shared/analytics.js` on all marketing pages. IDs come from `<meta name="ga-id">` and `<meta name="clarity-id">` — empty strings skip loading, so local dev stays silent.

## Microsoft Clarity

- Free, unlimited traffic, no sampling caps.
- Captures heatmaps, session recordings, scroll depth, rage clicks, dead clicks, quickbacks, excessive scrolling, JS errors.
- **Data Export API** (https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-data-export-api) returns aggregates by URL / device / country / OS / browser / referrer for the last 1–3 days, up to 10 calls/day per project.
- Auth: project-scoped API token generated in the Clarity dashboard (Settings → Data Export).
- Once issued, store it in Keychain as `CLARITY_API_TOKEN`. A maintenance routine or chat tool can then pull dashboards without logging in.

## Google Analytics 4

- **Data API** (https://developers.google.com/analytics/devguides/reporting/data/v1) — full reporting: users, sessions, events, conversions, funnels.
- Auth: service account JSON (recommended) or OAuth. Grant the service account Viewer on the GA4 property.
- Both Clarity and GA4 APIs are free to read and have official Node.js SDKs.

## Next steps for Owner

1. Create a GA4 property at https://analytics.google.com and copy the Measurement ID (`G-XXXXXXX`).
2. Create a project at https://clarity.microsoft.com and copy the Project ID.
3. Paste both into the `<meta name="ga-id">` and `<meta name="clarity-id">` tags in `apps/index.html`, `apps/licensing.html`, `apps/privacy.html`, and `apps/terms.html`.
