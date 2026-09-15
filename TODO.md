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
      RULED OUT: the root page's public share link has *not* lapsed.
      `/api/v3/getPublicPageData` returns `isPublicShareLink: true`,
      `requireLogin: false`, `publicAccess.disabled: false`, `isDeleted: false`,
      and `loadPageChunk` returns blocks normally. Notion is answering fine.
      Remaining suspects, in order:
      1. Redis. TLS is not enabled on the server, every request path touches the
         cache, and until the fix below there was no Keyv `error` listener — so a
         single connection error threw an uncaught exception and killed the
         lambda, 500ing everything in it. That listener is now attached, so a
         redeploy alone may clear the outage.
      2. `notion-client` 6.16 vs. the current Notion private API. A response-shape
         change would throw during render while simple fetches still succeed.
         Weak corroboration: the page block returned by `loadPageChunk` no longer
         carries a `space_id` field, so the shape has drifted somewhat from what
         this version of the library expects.
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
      `REDIS_PROTOCOL=rediss` in Vercel** if the server ever supports TLS. It
      currently does not — see "Accepted risks" below.
- [x] **No security headers.** `next.config.js` now sets `X-Content-Type-Options`,
      `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy` and `Permissions-Policy`
      on every route. A CSP is deliberately *not* set: this site renders arbitrary
      Notion content plus Twitter/PostHog/Fathom/Prism, so a blanket policy has to
      be tuned against real pages first.
- [x] **Open Notion proxy — ACL was inert.** `rootNotionSpaceId` was `null`,
      which disabled the workspace check in `lib/acl.ts` and
      `pages/api/notion-page-info.tsx`: anyone could load
      `https://www.yanbc.info/<any-public-notion-page-id>` and have this domain
      render — and ISR-cache — someone else's Notion page (phishing / spam / SEO
      poisoning under this domain, on this Vercel quota). Now set to
      `cf1ea656-17fa-4fa7-a13a-ad33c5c79bc5` ("Yanbc's Notion"), obtained from
      `/api/v3/getPublicPageData`. Together with the always-truthy-guard fix in P2,
      the workspace check is now actually enforced. This also bounds the unbounded
      ISR growth noted below.
- [x] **`dangerouslyAllowSVG: true`** (`next.config.js`). Decided by the site
      owner: keep SVG support enabled. No change. The residual risk is bounded by
      setting `rootNotionSpaceId` below, which stops an attacker from getting an
      attacker-authored page (and so an attacker-uploaded SVG) rendered through
      this origin in the first place.
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
- [x] **Domain mismatch.** `site.config.ts` said `domain: 'yanbc.info'`, which is
      not one of the two domains actually pointed at Vercel (`blog.yanbc.info` and
      `www.yanbc.info`). Every `<link rel="canonical">`, `og:url`, RSS `feed_url`,
      sitemap `<loc>` and social-image URL therefore advertised a host the site
      doesn't serve as primary. Now set to `www.yanbc.info`, chosen because it is
      what production was already serving, so nothing needs reindexing.
      `blog.yanbc.info` now 308-redirects to it in Vercel, so exactly one live
      address remains.
- [ ] **Unbounded ISR growth.** `fallback: true` plus any 32-hex string creates a
      new permanently-cached ISR entry per unique request, each triggering a full
      Notion fetch (`pages/[pageId].tsx`). Now bounded by `rootNotionSpaceId`,
      which rejects anything outside the workspace. Still worth considering
      `revalidate: 60` instead of `10`; left alone because it changes content
      freshness, which is a judgement call.

## Accepted risks

- **Redis connects over plaintext.** Verified in the Redis Cloud console: the
  Essentials free tier does not offer Transport Layer Security, so the password
  crosses the network in the clear. Accepted for now.

  Rationale: this database caches only LQIP preview images and
  `uri-to-page-id:*` slug mappings — no secrets, no user data. The meaningful
  risk is an on-path attacker recovering the password and poisoning the cache,
  and the worst version of that is already mitigated: a poisoned slug mapping
  sends `lib/resolve-notion-page.ts` to an attacker-chosen page, but the result
  still passes through `pageAcl`, which now rejects anything outside the
  workspace with a 404. Before `rootNotionSpaceId` was set, it would have
  rendered.

  Conditions: keep this Redis password unique to this database and reused
  nowhere else. On upgrading to a paid plan, enable TLS and set
  `REDIS_PROTOCOL=rediss` in Vercel — `@keyvhq/redis` wraps ioredis 5.3, which
  honours the `rediss://` scheme natively, so no code change is needed. If the
  provider requires a *client* certificate (mTLS) rather than plain server-side
  TLS, that does need code to pass the cert into ioredis.

- **CIDR allow list is deliberately Off.** Not a gap to close: Vercel's
  serverless egress IPs are dynamic on Hobby/Pro (static egress is an Enterprise
  feature), so any allowlist is either `0.0.0.0/0` — no security value — or a
  specific range that breaks the site whenever Vercel reassigns it. It is also
  unrelated to TLS; the two are independent controls.

## Suggested order

1. Deploy this branch — it may clear the P0 outage on its own (see P0).
2. If still down: `yarn dev`, hit `/api/search-notion`, read the stack trace.
3. The P2 remainder.
