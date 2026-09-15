# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A personal blog (yanbc.info, "Code & Cozy") built on a fork of `transitive-bullshit/nextjs-notion-starter-kit`. Notion is the CMS; Next.js 12 (pages router) renders public Notion pages via `react-notion-x`, deployed on Vercel. There is no local content — every page's data is fetched from Notion's unofficial API at build/ISR time.

Upstream is tracked as a git remote and merged in periodically, so prefer changes that stay close to upstream structure to keep merges clean.

## Commands

```bash
yarn dev          # local dev server (localhost:3000)
yarn build        # next build — also the CI check (.github/workflows/build.yml)
yarn start        # serve a production build
yarn deploy       # vercel deploy

yarn test         # runs test:lint + test:prettier in parallel
yarn test:lint    # eslint '**/*.{ts,tsx}'
yarn test:prettier # prettier --check

yarn analyze      # bundle analysis (ANALYZE=true next build)
```

There is no unit-test framework — "tests" are lint + format checks only. `yarn build` is the real correctness check, and it hits the network (Notion, image fetches, Redis), so it is slow; `staticPageGenerationTimeout` is raised to 300s for this reason.

Prettier uses `@trivago/prettier-plugin-sort-imports` with a specific group order (react/next → third-party → `@/lib`,`@/components`,`@/styles` → relative). Import order failures are a common `yarn test` failure; run prettier to fix rather than hand-sorting.

## Configuration model

`site.config.ts` is the single source of truth for site setup, consumed through two layers:

1. `lib/get-config-value.ts` merges `site.config.ts` with a JSON blob in `NEXT_PUBLIC_SITE_CONFIG` (env overrides file) and exposes `getSiteConfig` / `getEnv`, both of which **throw** on a missing value with no default.
2. `lib/config.ts` derives every runtime constant (page IDs, social handles, host/apiHost, redis URL, feature flags, the `api` route map). Application code imports from `@/lib/config`, never from `site.config.ts` directly.

Adding a config option means touching three files: the `SiteConfig` interface in `lib/site-config.ts`, the export in `lib/config.ts`, and `site.config.ts` itself. (This fork has already added `zhihu` this way.)

Path aliases `@/lib/*`, `@/components/*`, `@/styles/*` are defined in `tsconfig.json`. TypeScript runs with `strict: false`.

## Architecture

### Routing and page resolution

`pages/index.tsx` (root page) and `pages/[pageId].tsx` (everything else) both call `resolveNotionPage()` and render the same `components/NotionPage.tsx`. Both use `getStaticProps` with `revalidate: 10` and `fallback: true`, so new Notion pages appear without a redeploy.

`lib/resolve-notion-page.ts` is the core lookup, in priority order:
1. `parsePageId(rawPageId)` — a raw Notion ID in the URL.
2. `pageUrlOverrides` / `pageUrlAdditions` from site config.
3. A cached `uri-to-page-id:{domain}:{env}:{slug}` key in the Keyv store (permanent, no TTL).
4. Full site map crawl → `canonicalPageMap[slug]`, then the mapping is written back to the cache.

Misses return a `{ error: { statusCode: 404 } }` prop rather than throwing, and are deliberately not cached. All Redis failures in this path are caught and logged as warnings — the site must keep working with Redis down.

`lib/get-site-map.ts` crawls the whole workspace from `rootNotionPageId` via `getAllPagesInSpace` and is `pMemoize`d per process — expensive, and the reason a cold build is slow. It also detects duplicate slugs (warns and keeps the first).

URL slugs come from `lib/get-canonical-page-id.ts` → `lib/map-page-url.ts`. `includeNotionIdInUrls` defaults to `isDev`, so dev URLs carry the Notion ID suffix and production URLs don't; a page's `Slug` property in Notion overrides the generated slug.

### Notion data flow

`lib/notion-api.ts` holds the single `NotionAPI` client (unofficial API — the root page must be publicly shared). `lib/notion.ts#getPage` wraps it and layers on: merged record maps for custom-navigation link pages (only when `navigationStyle !== 'default'`), and the LQIP preview-image map attached as `recordMap.preview_images`.

`lib/preview-images.ts` downloads every image in a record map, generates a base64 LQIP via `lqip-modern`, and caches it in the Keyv store keyed by normalized URL. `lib/db.ts` is that store: Redis-backed when `isRedisEnabled` (currently **on** in this fork, requiring `REDIS_HOST`/`REDIS_PASSWORD`), otherwise an in-memory Keyv that vanishes between builds. Disabling `isPreviewImageSupportEnabled` is the fastest way to speed up builds when debugging.

`lib/acl.ts#pageAcl` gates rendering: it rejects pages whose `space_id` doesn't match `rootNotionSpaceId` (only enforced when that is configured — it is `null` here).

### Rendering

`components/NotionPage.tsx` is where nearly all presentation decisions live. It passes a `components` map to `NotionRenderer` that dynamically imports the heavy `react-notion-x` third-party bundles (Code + a hand-picked Prism language list, Collection, Equation, Pdf, Modal) and overrides property renderers (`propertyDateValue`, `propertyLastEditedTimeValue`, `propertyTextValue`) to special-case the `Published` / `Author` properties in page headers.

A page is treated as a blog post when `block.type === 'page' && block.parent_table === 'collection'`; that alone drives the table-of-contents aside. `?lite=true` renders the embed-friendly variant (used by oEmbed). In the browser, `pageId`, `recordMap`, and `block` are attached to `window` for debugging — `block.space_id` is how you find the workspace ID.

CSS overrides for Notion content go in `styles/notion.css`, which targets global classnames from `react-notion-x`'s `styles.css`. Every block also gets a `.notion-block-<id>` class, so individual blocks can be targeted by ID.

### API routes

- `pages/api/search-notion.ts` — proxies Notion search for the CMD+K modal (`lib/search-notion.ts` memoizes client-side with a 10s expiry).
- `pages/api/notion-page-info.tsx` — returns title/author/image/date for a page; enforces the workspace check itself.
- `pages/api/social-image.tsx` — **edge runtime** (`@vercel/og`); fetches `notion-page-info` over HTTP via `apiHost` and renders the OG image with fonts from `public/fonts`. Because it's edge, it cannot import the Node-only Notion/Redis code, hence the internal HTTP hop.
- `pages/feed.tsx`, `sitemap.xml.tsx`, `robots.txt.tsx` — `getServerSideProps` routes that write their response directly and return `{ props: {} }`.

New image hosts must be added to `next.config.js#images.domains` or `next/image` will reject them at runtime.
