# Public docs projection

The public docs answer bundle is generated from canonical public sources registered in
`config/public-truth-sources.json`. The JSON files in `apps/static/faq/` are
compatibility outputs, not editable product truth.

```bash
node scripts/generate-public-truth.js
```

The generator updates `lib/public-chat/public-truth.js`,
`lib/public-chat/faq-bundle.js`, `apps/static/public-truth.json`,
`apps/static/faq-data.json`, `apps/static/faq/*.json`, `apps/static/llms.txt`,
`apps/static/llms-full.txt`, and the homepage FAQ block in `apps/index.html`.
