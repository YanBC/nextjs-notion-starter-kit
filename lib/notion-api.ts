import { NotionAPI } from 'notion-client'

// Notion's private API answers 403 to requests coming from datacenter IP ranges
// that don't look like a browser — which is every Vercel build and every
// serverless render. `got` identifies itself as `got (https://github.com/...)`
// by default, which is exactly the shape that gets refused; the same request
// succeeds from a residential IP, which is why this only ever breaks in
// production. notion-client has no global option for this, so these options are
// threaded through each call site explicitly.
export const notionGotOptions = {
  headers: {
    'user-agent':
      process.env.NOTION_USER_AGENT ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9'
  }
}

export const notion = new NotionAPI({
  apiBaseUrl: process.env.NOTION_API_BASE_URL,

  // Optional fallback if the headers above aren't enough to get past the 403: a
  // `token_v2` session cookie from a logged-in Notion account. This grants full
  // access to that account, so it belongs in an environment variable and must
  // never be committed. Unset, the client stays anonymous exactly as before.
  authToken: process.env.NOTION_TOKEN,
  activeUser: process.env.NOTION_ACTIVE_USER
})
