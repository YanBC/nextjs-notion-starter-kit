// eslint-disable-next-line @typescript-eslint/no-var-requires
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true'
})

// eslint-disable-next-line @typescript-eslint/no-var-requires
const imageDomains = require('./lib/image-domains')

// Baseline hardening. Note there is deliberately no Content-Security-Policy
// here: this site renders arbitrary Notion content alongside third-party
// embeds (Twitter, PostHog, Fathom, Prism), so a blanket policy needs to be
// tuned against real pages before it can be turned on without breaking them.
//
// X-Frame-Options is SAMEORIGIN rather than DENY because lib/oembed.ts is
// designed to embed this site in an iframe; it isn't wired to a route today,
// but relax this to a frame-ancestors CSP if it ever is.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()'
  }
]

module.exports = withBundleAnalyzer({
  staticPageGenerationTimeout: 300,
  images: {
    domains: imageDomains,
    formats: ['image/avif', 'image/webp'],
    dangerouslyAllowSVG: true,
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;"
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders
      }
    ]
  }
})
