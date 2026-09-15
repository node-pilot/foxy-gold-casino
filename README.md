# V3 Casino Site Template

Source-of-truth template for sites built by the LEVR V3 Agentic Builder.

When the V3 builder starts a new site, the `create_repo` tool clones this
template into a new GitHub repo. The agent then writes pages into
`public/`, attaches Media Library assets into `public/assets/`, and
commits a `levr.json` + `links.json` at the repo root before promoting
the site live.

## Sources of truth in a built site repo

| File / directory | Purpose |
|---|---|
| `levr.json` | Per-site metadata: brand, markets, languages, pages list, asset inventory, SEO defaults. Operators may hand-edit. |
| `links.json` | Affiliate slot assignments. Managed by the Affiliate Manager (future). Agent leaves it `{"schema_version":"1.0","assignments":[]}`. |
| `public/**/*.html` | Page bodies. Contain `<!-- #include -->` directives that reference partials. |
| `public/partials/*.html` | Shared chrome: header, footer, payment-row, compliance-row. |
| `public/assets/**/*` | Copied Media Library assets — local only, no LEVR hotlinks. |
| `src/index.ts` | The SSI runtime Worker. Don't edit unless intentional. |

D1 + Cloudflare Workers Analytics are caches/aggregates and can be
rebuilt from the files above using the recovery tool (future).

## Include directive syntax

```html
<!-- #include file="/partials/header.html" -->
```

Rules (enforced by `src/index.ts`):

- File path MUST start with `/` (absolute from `public/`).
- One pass only — partials cannot themselves contain `#include`
  directives. They will be left as-is (the comment marker is visible
  in page source for debugging).
- All directives in a page are resolved in parallel against the
  `ASSETS` binding, then spliced into the HTML in document order.

## Per-page SEO requirements

Every page MUST have:

- `<title>` (front-load brand, target keyword)
- `<meta name="description" content="...">` (150–160 chars)
- `<link rel="canonical" href="...">`
- `og:title`, `og:description`, `og:url`, `og:image`
- At least one `application/ld+json` block (Organization on home,
  WebPage / BreadcrumbList on others as appropriate)

The agent's `validate_page` tool enforces these before a page can be
committed.

## Local development

```bash
pnpm install
pnpm dev          # wrangler dev — runs ESI processor + static assets
pnpm test         # vitest — include splice tests
pnpm typecheck
```

## Deploy

GitHub Actions on push to `main` runs `wrangler deploy` (see
`.github/workflows/deploy.yml`). CF account ID + API token come from
repo secrets `CF_ACCOUNT_ID` and `CF_API_TOKEN` set by the V3 agent's
`deploy_worker` tool when the repo is first created.
