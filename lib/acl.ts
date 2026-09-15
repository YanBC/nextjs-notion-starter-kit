import { PageProps } from './types'

export async function pageAcl({
  site,
  recordMap,
  pageId
}: PageProps): Promise<PageProps> {
  if (!site) {
    return {
      error: {
        statusCode: 404,
        message: 'Unable to resolve notion site'
      }
    }
  }

  if (!recordMap) {
    return {
      error: {
        statusCode: 404,
        message: `Unable to resolve page for domain "${site.domain}". Notion page "${pageId}" not found.`
      }
    }
  }

  const keys = Object.keys(recordMap.block)
  const rootKey = keys[0]

  if (!rootKey) {
    return {
      error: {
        statusCode: 404,
        message: `Unable to resolve page for domain "${site.domain}". Notion page "${pageId}" invalid data.`
      }
    }
  }

  const rootValue = recordMap.block[rootKey]?.value
  const rootSpaceId = rootValue?.space_id

  if (
    rootSpaceId &&
    site.rootNotionSpaceId &&
    rootSpaceId !== site.rootNotionSpaceId
  ) {
    // note: this was previously wrapped in `if (process.env.NODE_ENV)`, which is
    // always truthy ('production' | 'development' | 'test'), so the guard it was
    // meant to express never existed. The workspace check is the entire point of
    // this function, so it now applies unconditionally.
    return {
      error: {
        statusCode: 404,
        message: `Notion page "${pageId}" doesn't belong to the Notion workspace owned by "${site.domain}".`
      }
    }
  }
}
