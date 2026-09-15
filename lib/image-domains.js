/**
 * Hosts this site is willing to fetch and optimize images from.
 *
 * Shared deliberately: `next.config.js` uses it for `next/image`, and
 * `lib/image-fetch.ts` uses it to bound the server-side image fetches made
 * during preview-image generation and OG-image rendering. Keeping one list
 * prevents the two from drifting apart.
 */
module.exports = [
  'www.notion.so',
  'notion.so',
  'images.unsplash.com',
  'pbs.twimg.com',
  'abs.twimg.com',
  's3.us-west-2.amazonaws.com',
  'transitivebullsh.it'
]
