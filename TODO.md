# TODO — audit findings (2026-09-15)

Findings from a code + live-deployment audit of yanbc.info. Ordered by priority.
File references are `path:line` as of commit `e9e76e9`.

## P0 — production is broken

Production serves a ~220-day-old stale ISR cache (`x-vercel-cache: STALE`, `age: 19008048`).
Every route that talks to Notion at request time returns 500:
`/sitemap.xml`, `/feed`, `/api/search-notion`, `/api/notion-page-info`,
`/api/social-image`, and `/_next/data/<buildId>/<pageId>.json` for uncached paths.
`revalidate: 10` retries constantly, each attempt throws, Vercel keeps serving the
last successful build. Effect: search dead, all OG/social images broken, RSS +
sitemap dead (SEO), new/edited Notion pages never appear.

- [ ] Root-cause the 500s. Need `vercel logs <deployment-url>` or a read-scoped
      Vercel token. Fastest local repro: `yarn dev`, then hit
      `localhost:3000/api/search-notion` and read the stack trace.
      Suspects: `notion-client` 6.16 vs. current Notion private API, root page's
      public share link lapsed, or Redis (see "Keyv error listener" below).
- [ ] After the fix, confirm `/feed`, `/sitemap.xml`, `/api/social-image?id=<root>`
      all return 200 and that `x-vercel-cache` goes `HIT`/`MISS` rather than `STALE`.

## P1 — security

- [ ] **Open Notion proxy — ACL is inert.** `site.config.ts:9` sets
      `rootNotionSpaceId: null`, which disables both workspace checks
      (`lib/acl.ts:41-45`, `pages/api/notion-page-info.tsx:39-47`). Anyone can load
      `https://yanbc.info/<any-public-notion-page-id>` and have your domain render —
      and ISR-cache — someone else's Notion page. Phishing / spam / SEO poisoning
      under your domain, on your Vercel quota.
      Fix: open the site, read `window.block.space_id` in the console, set
      `rootNotionSpaceId` in `site.config.ts`.
- [ ] **Blind SSRF in `/api/notion-page-info`** (`pages/api/notion-page-info.tsx:122-133`).
      With the ACL off, an attacker points `pageId` at a Notion page they control
      whose `Social Image` property / cover is an arbitrary URL; the server does
      `got.head(url)` with no host allowlist, no timeout, redirects followed —
      an internal-reachability oracle from inside Vercel's network.
      `lib/preview-images.ts:52` is worse: `got(url, {responseType: 'buffer'})`
      downloads attacker-chosen URLs with no size cap into lambda memory.
      Fix: the ACL above closes most of it; add a host allowlist + timeout +
      size cap on image fetches to close it properly.
- [ ] **`/api/search-notion` forwards the raw request body to Notion**
      (`pages/api/search-notion.ts:11-14`). No auth, no rate limit, no validation —
      caller controls `ancestorId`, `limit`, `filters` using your Notion session.
      Fix: pin `ancestorId` to `rootNotionPageId`, whitelist `query`/`limit`,
      cap query length, add rate limiting.
- [ ] **`lib/db.ts` has no `error` listener.** Keyv re-emits store errors; an
      unhandled `'error'` event on an EventEmitter throws and kills the process, so
      one Redis blip 500s everything in that lambda. Plausible cause of the P0 outage.
      Fix: `db.on('error', (err) => console.warn('keyv error', err))`.
- [ ] **`redisUrl` has no TLS and no port** (`lib/config.ts:126-129`):
      `redis://user:pass@host`. Most managed Redis wants `rediss://` + explicit port;
      without TLS the password crosses the network in plaintext. If `REDIS_HOST` is
      unset the URL silently becomes `redis://default:undefined@undefined`.
- [ ] **No security headers.** Only Vercel's HSTS — no CSP, `X-Frame-Options`,
      `Referrer-Policy`, `X-Content-Type-Options`, `Permissions-Policy`.
      Add a `headers()` block to `next.config.js`. Note `lib/oembed.ts` embeds the
      site in an iframe, so choose `frame-ancestors` deliberately rather than a
      blanket `DENY`.
- [ ] **`dangerouslyAllowSVG: true`** (`next.config.js:19`). Mitigated by the CSP on
      the image response, but combined with the open proxy (attacker-controlled
      Notion page → attacker-uploaded SVG on `s3.us-west-2.amazonaws.com`) it is
      served through your origin. Turn off unless SVG covers are actually used.
- [ ] **Next.js 12.3.4 is end-of-life** — no security patches since 2023. Not
      currently exploitable here (CVE-2025-29927 needs middleware, which this app
      doesn't have), but unpatched image-optimizer and cache advisories accumulate.
      Upgrading is a big jump (12 → 15); upstream has moved on too.

## P2 — bugs

- [ ] **Domain mismatch.** `site.config.ts:13` sets `domain: 'yanbc.info'`, but
      production serves `www.yanbc.info` and the apex 308-redirects. Every
      `<link rel="canonical">`, `og:url`, RSS `feed_url`, sitemap `<loc>` and
      social-image URL points at the redirecting host — self-referential canonicals
      are wrong site-wide. Fix: set `domain: 'www.yanbc.info'`, or make the apex
      primary in Vercel.
- [ ] **API routes `throw` instead of returning 4xx**
      (`pages/api/notion-page-info.tsx:25,34`). An invalid `pageId` becomes a 500
      HTML error page rather than a 400 JSON body.
- [ ] **Logging the entire record map.** `components/NotionPage.tsx:215` logs the
      full `recordMap` — server-side (Vercel log cost, full page content in logs)
      and in every visitor's console. Same for `pages/api/search-notion.ts:15`
      (full results), `lib/resolve-notion-page.ts:85` (`console.log(site)`), and
      `pages/[pageId].tsx:48` (every static path). Strip before redeploying, since
      a working deploy will actually push traffic through these.
- [ ] **`lib/acl.ts:46` — `if (process.env.NODE_ENV)` is always truthy.**
      `NODE_ENV` is always `'production'` or `'development'`; the intended dev
      bypass never works. Upstream bug. Harmless today only because the outer
      condition can't fire while `rootNotionSpaceId` is null.
- [ ] **`lib/oembed.ts` is dead code and would crash if wired up** —
      `user.given_name` at `lib/oembed.ts:30` has no optional chaining after an
      `?.value` that can be undefined. No API route imports it.
- [ ] **Unbounded ISR growth.** `fallback: true` plus any 32-hex string creates a
      new permanently-cached ISR entry per unique request, each triggering a full
      Notion fetch (`pages/[pageId].tsx:28-50`). The ACL fix bounds this; also
      consider `revalidate: 60` instead of `10`.

## Suggested order

1. Vercel logs → fix the P0 outage (ship the `rootNotionSpaceId` fix alongside, it's cheap).
2. One commit: `rootNotionSpaceId` + Keyv error handler + `search-notion` input validation.
3. Security headers + log cleanup.
4. Domain mismatch, then the P2 remainder.
