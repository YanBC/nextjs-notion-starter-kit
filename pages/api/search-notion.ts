import { NextApiRequest, NextApiResponse } from 'next'

import * as types from '../../lib/types'
import { rootNotionPageId } from '../../lib/config'
import { search } from '../../lib/notion'

// This endpoint is public and unauthenticated, but `search` runs against this
// site's Notion session. The request body is therefore never forwarded
// verbatim: `ancestorId` is pinned to this site's root page so a caller can't
// search someone else's workspace, and the remaining inputs are bounded.
//
// `filters` is deliberately omitted — notion-client already supplies the
// defaults, and accepting caller-supplied filters is what made this forwardable
// in the first place.
const MAX_QUERY_LENGTH = 256
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'method not allowed' })
  }

  const query = req.body?.query

  // note: react-notion-x warms the search index with an empty query on mount,
  // so '' is valid input and must not be rejected
  if (typeof query !== 'string' || query.length > MAX_QUERY_LENGTH) {
    return res.status(400).send({ error: 'invalid query' })
  }

  const rawLimit = Number.parseInt(req.body?.limit, 10)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT

  const searchParams: types.SearchParams = {
    query,
    limit,
    ancestorId: rootNotionPageId
  }

  try {
    const results = await search(searchParams)

    res.setHeader(
      'Cache-Control',
      'public, s-maxage=60, max-age=60, stale-while-revalidate=60'
    )
    return res.status(200).json(results)
  } catch (err) {
    console.warn('search-notion error', err.message)
    return res.status(502).send({ error: 'search failed' })
  }
}
