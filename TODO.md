# TODO — audit findings

Findings from a code + live-deployment audit of yanbc.info (2026-09-15).
Items marked `[x]` were fixed in the follow-up commit; the rest are still open,
and the ones under "Blocked on input" need information only the site owner has.

## P0 — production is broken

Production serves a ~220-day-old stale ISR cache (`x-vercel-cache: STALE`, `age: 19008048`).
Every route that talks to Notion at request time returns 500:
`/sitemap.xml`, `/feed`, `/api/search-notion`, `/api/notion-page-info`,
`/api/social-image`, and `/_next/data/<buildId>/<pageId>.json` for uncached paths.
`revalidate: 10` retries constantly, each attempt throws, Vercel keeps serving the
last successful build. Effect: search dead, all OG/social images broken, RSS +
sitemap dead (SEO), new/edited Notion pages never appear.

- [ ] Root-cause the 500s. Needs `vercel logs <deployment-url>` or a read-scoped
      Vercel token. Fastest local repro: `yarn dev`, then hit
      `localhost:3000/api/search-notion` and read the stack trace.
      Remaining suspects, in order:
      1. The root page's public share link lapsed (most likely — it produces a
         Notion 403/404 on every request and needs no code change to fix).
      2. Redis. The missing Keyv `error` listener below is fixed, which removes
         the "one blip kills the lambda" failure mode, so if Redis was the cause
         the site should recover on the next deploy.
      3. `notion-client` 6.16 vs. the current Notion private API.
- [ ] After the fix, confirm `/feed`, `/sitemap.xml`, `/api/social-image?id=<root>`
      all return 200 and that `x-vercel-cache` goes `HIT`/`MISS` rather than `STALE`.

## P1 — security

- [x] **`lib/db.ts` had no `error` listener.** Keyv re-emits store errors; an
      unhandled `'error'` event on an EventEmitter throws and kills the process, so
      one Redis blip 500s everything in that lambda. A listener now downgrades it
      to a warning — every caller already treats the cache as best-effort.
- [x] **`/api/search-notion` forwarded the raw request body to Notion.** The body
      is no longer forwarded: `ancestorId` is pinned to `rootNotionPageId`,
      `query` must be a string of at most 256 chars, `limit` is clamped to 1..100,
      and caller-supplied `filters` are dropped (notion-client supplies the
      defaults). Note the empty query is still allowed — react-notion-x warms the
      search index with one on mount.
- [x] **Blind SSRF in image fetches.** `lib/image-fetch.ts` now gates every
      server-side image fetch on a hostname allowlist (shared with
      `next/image` via `lib/image-domains.js`), with a 10s timeout, at most 3
      redirects, and a 10 MB cap enforced via `downloadProgress` so an
      attacker-chosen URL can't exhaust lambda memory. This also closes a hole
      in `react-notion-x`'s `defaultMapImageUrl`, which passes a URL through
      untouched when it merely *starts with* `https://images.unsplash.com` —
      `images.unsplash.com.example.net` satisfied that prefix match.
- [x] **`redisUrl` had no TLS, no port, and silently became
      `redis://default:undefined@undefined`** when `REDIS_HOST` was unset.
      It is now `null` in that case (and `lib/db.ts` falls back to an in-memory
      cache with a warning), credentials are URL-encoded, and `REDIS_PROTOCOL` /
      `REDIS_PORT` / `REDIS_URL` are configurable. **The default is still plain
      `redis://` to avoid breaking a working deployment — set
      `REDIS_PROTOCOL=rediss` in Vercel.** See "Blocked on input".
- [x] **No security headers.** `next.config.js` now sets `X-Content-Type-Options`,
      `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy` and `Permissions-Policy`
      on every route. A CSP is deliberately *not* set: this site renders arbitrary
      Notion content plus Twitter/PostHog/Fathom/Prism, so a blanket policy has to
      be tuned against real pages first.
- [ ] **Open Notion proxy — ACL is inert.** `site.config.ts:9` sets
      `rootNotionSpaceId: null`, which disables the workspace check in
      `lib/acl.ts` and `pages/api/notion-page-info.tsx`. Anyone can load
      `https://yanbc.info/<any-public-notion-page-id>` and have your domain render —
      and ISR-cache — someone else's Notion page. Phishing / spam / SEO poisoning
      under your domain, on your Vercel quota. The check itself is now fixed (see
      P2), so this needs only the ID. See "Blocked on input".
- [ ] **`dangerouslyAllowSVG: true`** (`next.config.js`). Left on deliberately —
      turning it off breaks any Notion page using an SVG icon or cover, which I
      can't verify from here. See "Blocked on input".
- [ ] **Next.js 12.3.4 is end-of-life** — no security patches since 2023. Not
      currently exploitable here (CVE-2025-29927 needs middleware, which this app
      doesn't have), but unpatched image-optimizer and cache advisories accumulate.
      Upgrading is a big jump (12 → 15); upstream has moved on too.

## P2 — bugs

- [x] **`lib/acl.ts` — `if (process.env.NODE_ENV)` is always truthy.**
      `NODE_ENV` is always `'production'`, `'development'` or `'test'`, so the
      guard it was meant to express never existed. The workspace check is the
      point of the function, so it now applies unconditionally. (Upstream bug.)
- [x] **API routes `throw` instead of returning 4xx.** An invalid `pageId` was a
      500 HTML error page; it is now a 400 JSON body, an unresolvable page is a
      404, and a Notion outage is a 502 from `/api/search-notion` rather than an
      unhandled rejection.
- [x] **Logging the entire record map.** `components/NotionPage.tsx` logged the
      full `recordMap` server-side and in every visitor's console; it is now
      dev-only and omits the record map. Also removed: full search results
      (`pages/api/search-notion.ts`), `console.log(site)`
      (`lib/resolve-notion-page.ts`), every static path (`pages/[pageId].tsx`),
      the per-image `lqip` line (`lib/preview-images.ts`), and the page info dump
      (`pages/api/social-image.tsx`). The build-time crawl log in
      `lib/get-site-map.ts` is kept — it's useful build output and leaks nothing.
- [x] **`lib/oembed.ts` would crash if wired up** — `user.given_name` had no
      optional chaining after an `?.value` that can be undefined. Fixed, though
      the module is still dead code (no API route imports it).
- [x] **`yarn test` was failing** on two pre-existing Prettier violations
      (`components/PageHead.tsx`, `lib/site-config.ts`). CI only runs `yarn build`,
      so this went unnoticed.
- [ ] **Domain mismatch.** See "Blocked on input".
- [ ] **Unbounded ISR growth.** `fallback: true` plus any 32-hex string creates a
      new permanently-cached ISR entry per unique request, each triggering a full
      Notion fetch (`pages/[pageId].tsx`). Setting `rootNotionSpaceId` bounds this;
      also consider `revalidate: 60` instead of `10`. Left alone for now because it
      changes content freshness, which is a judgement call.

## Blocked on input

- [ ] **`rootNotionSpaceId`.** Open yanbc.info, run `window.block.space_id` in the
      browser console, and put the result in `site.config.ts`. This single value
      closes the open-proxy issue and bounds ISR growth.
- [ ] **Domain.** `site.config.ts` says `yanbc.info`, but production serves
      `www.yanbc.info` and the apex 308-redirects. Every `<link rel="canonical">`,
      `og:url`, RSS `feed_url`, sitemap `<loc>` and social-image URL therefore
      points at a redirecting host — self-referential canonicals are wrong
      site-wide. Either set `domain: 'www.yanbc.info'` or make the apex primary in
      Vercel; both are correct, but they must agree.
- [ ] **SVG covers.** If no Notion page uses an SVG icon or cover, set
      `dangerouslyAllowSVG: false` in `next.config.js`.
- [ ] **Redis TLS.** If the provider supports it (Upstash and Redis Cloud both do),
      set `REDIS_PROTOCOL=rediss` — and `REDIS_PORT` if it isn't 6379 — in the
      Vercel environment. Without it the password crosses the network in plaintext.

## Suggested order

1. Set `rootNotionSpaceId` and `REDIS_PROTOCOL=rediss`, redeploy.
2. Vercel logs → fix the P0 outage.
3. Domain mismatch, then the P2 remainder.
