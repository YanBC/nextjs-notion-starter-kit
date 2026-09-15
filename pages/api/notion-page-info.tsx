import { NextApiRequest, NextApiResponse } from 'next'

import { PageBlock } from 'notion-types'
import {
  getBlockIcon,
  getBlockTitle,
  getPageProperty,
  isUrl,
  parsePageId
} from 'notion-utils'

import * as libConfig from '@/lib/config'
import { isImageUrlReachable } from '@/lib/image-fetch'
import { mapImageUrl } from '@/lib/map-image-url'
import { notion, notionGotOptions } from '@/lib/notion-api'
import { ExtendedRecordMap, NotionPageInfo } from '@/lib/types'

export default async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    return res.status(405).send({ error: 'method not allowed' })
  }

  const pageId: string = parsePageId(req.body?.pageId)
  if (!pageId) {
    return res.status(400).send({ error: 'invalid notion page id' })
  }

  let recordMap: ExtendedRecordMap
  try {
    recordMap = await notion.getPage(pageId, {
      gotOptions: notionGotOptions
    })
  } catch (err) {
    console.warn('notion-page-info error', pageId, err.message)
    return res.status(404).send({ error: `notion page "${pageId}" not found` })
  }

  const keys = Object.keys(recordMap?.block || {})
  const block = recordMap?.block?.[keys[0]]?.value

  if (!block) {
    return res
      .status(404)
      .send({ error: `invalid recordMap for page "${pageId}"` })
  }

  const blockSpaceId = block.space_id

  if (
    blockSpaceId &&
    libConfig.rootNotionSpaceId &&
    blockSpaceId !== libConfig.rootNotionSpaceId
  ) {
    return res.status(400).send({
      error: `Notion page "${pageId}" belongs to a different workspace.`
    })
  }

  const isBlogPost =
    block.type === 'page' && block.parent_table === 'collection'
  const title = getBlockTitle(block, recordMap) || libConfig.name

  const imageCoverPosition =
    (block as PageBlock).format?.page_cover_position ??
    libConfig.defaultPageCoverPosition
  const imageObjectPosition = imageCoverPosition
    ? `center ${(1 - imageCoverPosition) * 100}%`
    : null

  const imageBlockUrl = mapImageUrl(
    getPageProperty<string>('Social Image', block, recordMap) ||
      (block as PageBlock).format?.page_cover,
    block
  )
  const imageFallbackUrl = mapImageUrl(libConfig.defaultPageCover, block)

  const blockIcon = getBlockIcon(block, recordMap)
  const authorImageBlockUrl = mapImageUrl(
    blockIcon && isUrl(blockIcon) ? blockIcon : null,
    block
  )
  const authorImageFallbackUrl = mapImageUrl(libConfig.defaultPageIcon, block)
  const [authorImage, image] = await Promise.all([
    getCompatibleImageUrl(authorImageBlockUrl, authorImageFallbackUrl),
    getCompatibleImageUrl(imageBlockUrl, imageFallbackUrl)
  ])

  const author =
    getPageProperty<string>('Author', block, recordMap) || libConfig.author

  // const socialDescription =
  //   getPageProperty<string>('Description', block, recordMap) ||
  //   libConfig.description

  // const lastUpdatedTime = getPageProperty<number>(
  //   'Last Updated',
  //   block,
  //   recordMap
  // )
  const publishedTime = getPageProperty<number>('Published', block, recordMap)
  const datePublished = publishedTime ? new Date(publishedTime) : undefined
  // const dateUpdated = lastUpdatedTime
  //   ? new Date(lastUpdatedTime)
  //   : publishedTime
  //   ? new Date(publishedTime)
  //   : undefined
  const date =
    isBlogPost && datePublished
      ? `${datePublished.toLocaleString('en-US', {
          month: 'long'
        })} ${datePublished.getFullYear()}`
      : undefined
  const detail = date || author || libConfig.domain

  const pageInfo: NotionPageInfo = {
    pageId,
    title,
    image,
    imageObjectPosition,
    author,
    authorImage,
    detail
  }

  res.setHeader(
    'Cache-Control',
    'public, s-maxage=3600, max-age=3600, stale-while-revalidate=3600'
  )
  res.status(200).json(pageInfo)
}

async function getCompatibleImageUrl(
  url: string | null,
  fallbackUrl: string | null
): Promise<string | null> {
  const image = (await isImageUrlReachable(url)) ? url : fallbackUrl

  if (image) {
    try {
      const imageUrl = new URL(image)

      if (imageUrl.host === 'images.unsplash.com') {
        if (!imageUrl.searchParams.has('w')) {
          imageUrl.searchParams.set('w', '1200')
          imageUrl.searchParams.set('fit', 'max')
          return imageUrl.toString()
        }
      }
    } catch {
      // a non-URL fallback (e.g. a misconfigured defaultPageCover) shouldn't 500
      return null
    }
  }

  return image
}
