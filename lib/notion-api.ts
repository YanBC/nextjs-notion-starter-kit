import { NotionAPI } from 'notion-client'

// Notion's private API answers 403 to requests from datacenter IP ranges that
// don't look like a browser — which is every Vercel build and every serverless
// render. `got` identifies itself as `got (https://github.com/sindresorhus/got)`
// by default, which is the shape that gets refused; the same request succeeds
// from a residential IP, which is why this only ever breaks in production.
const notionHeaders = {
  'user-agent':
    process.env.NOTION_USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'accept-language': 'en-US,en;q=0.9'
}

// Record tables whose entries carry a `value`. `collection_query` and
// `signed_urls` are plain maps, not record tables, so they are left alone.
const recordTables = ['block', 'collection', 'collection_view', 'notion_user']

/**
 * Reshape a `__version__: 3` record map into the shape notion-client 6.16 and
 * react-notion-x 6.16 expect.
 *
 * Notion now returns:   `{ spaceId, value: { value: <record>, role } }`
 * These libraries want: `{ role, value: <record> }`
 *
 * Every consumer reads `entry.value.<field>` and gets `undefined`. That is what
 * crashes the export with `uuidToId(block.id)` → "Cannot read properties of
 * undefined (reading 'replace')", and it is also why `lib/acl.ts` sees no
 * `space_id` and silently waves every page through.
 *
 * Both fixes are idempotent and shape-checked, so a record map already in the
 * old shape passes through untouched.
 */
export function normalizeRecordMap<T>(recordMap: T): T {
  if (!recordMap) {
    return recordMap
  }

  for (const table of recordTables) {
    const records = recordMap[table]
    if (!records) {
      continue
    }

    for (const id of Object.keys(records)) {
      const entry = records[id]
      const value = entry?.value
      if (!value) {
        continue
      }

      // unwrap `value: { value: <record>, role }`
      if (!value.id && value.value?.id) {
        entry.value = value.value

        if (!entry.role && value.role) {
          entry.role = value.role
        }
      }

      // `space_id` moved off the record and up to the entry as `spaceId`
      if (entry.spaceId && entry.value && !entry.value.space_id) {
        entry.value.space_id = entry.spaceId
      }
    }
  }

  return recordMap
}

/**
 * Applies both workarounds in one place.
 *
 * Normalizing inside `fetch` rather than after `getPage` is deliberate:
 * notion-client walks the record map itself to decide which blocks and
 * collections still need fetching, so it has to see the corrected shape too.
 * Doing it here also means no call site can forget either fix.
 */
class PatchedNotionAPI extends NotionAPI {
  public async fetch<T>({
    endpoint,
    body,
    gotOptions,
    headers
  }: {
    endpoint: string
    body: object
    gotOptions?: any
    headers?: any
  }): Promise<T> {
    const res = await super.fetch<T>({
      endpoint,
      body,
      headers,
      gotOptions: {
        ...gotOptions,
        headers: { ...notionHeaders, ...gotOptions?.headers }
      }
    })

    normalizeRecordMap((res as any)?.recordMap)

    return res
  }
}

export const notion = new PatchedNotionAPI({
  apiBaseUrl: process.env.NOTION_API_BASE_URL,

  // Optional. A `token_v2` session cookie, if an authenticated client is ever
  // needed. This grants full access to that Notion account, so it belongs in an
  // environment variable and must never be committed. Unset, the client stays
  // anonymous — which is all the public blog needs.
  authToken: process.env.NOTION_TOKEN,
  activeUser: process.env.NOTION_ACTIVE_USER
})
