import got from 'got'

import imageDomains from './image-domains'

// Image fetches happen server-side, inside a lambda, against URLs that
// ultimately come from Notion page content. Without these bounds an
// attacker-authored page is an internal-reachability oracle (arbitrary host,
// redirects followed) and an easy way to exhaust lambda memory.
export const IMAGE_FETCH_TIMEOUT_MS = 10000
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_REDIRECTS = 3

const allowedImageHosts = new Set<string>(imageDomains)

const gotImageOptions = {
  timeout: { request: IMAGE_FETCH_TIMEOUT_MS },
  retry: { limit: 1 },
  maxRedirects: MAX_IMAGE_REDIRECTS
} as const

/**
 * Whether we're willing to make a server-side request for `url`.
 *
 * Note this compares `URL.hostname` rather than doing a string prefix match.
 * `react-notion-x`'s `defaultMapImageUrl` passes a URL through untouched when it
 * merely *starts with* `https://images.unsplash.com`, which a host like
 * `images.unsplash.com.example.net` also satisfies.
 */
export function isAllowedImageUrl(url: string): boolean {
  try {
    const { protocol, hostname, pathname } = new URL(url)

    if (protocol !== 'https:') {
      return false
    }

    if (allowedImageHosts.has(hostname)) {
      return true
    }

    // Notion serves uploaded files from its own S3 bucket; the region — and so
    // the hostname — varies, and `react-notion-x` passes these signed URLs
    // through rather than proxying them via www.notion.so.
    return (
      hostname.endsWith('.amazonaws.com') &&
      pathname.startsWith('/secure.notion-static.com')
    )
  } catch {
    return false
  }
}

/** HEAD `url`, returning false rather than throwing for anything unreachable. */
export async function isImageUrlReachable(
  url: string | null
): Promise<boolean> {
  if (!url || !isAllowedImageUrl(url)) {
    return false
  }

  try {
    await got.head(url, gotImageOptions)
    return true
  } catch {
    return false
  }
}

/** Download `url` as a buffer, aborting past `MAX_IMAGE_BYTES`. */
export async function fetchImageBuffer(url: string): Promise<Buffer> {
  if (!isAllowedImageUrl(url)) {
    throw new Error(`refusing to fetch image from disallowed host "${url}"`)
  }

  const request = got(url, { ...gotImageOptions, responseType: 'buffer' })

  request.on('downloadProgress', ({ transferred }) => {
    if (transferred > MAX_IMAGE_BYTES) {
      request.cancel()
    }
  })

  const { body } = await request
  return body
}
