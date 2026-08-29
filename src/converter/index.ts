import { extractContent, getPageHTML, getSelectionHTML } from './extractor'
import { htmlToMarkdown } from './markdown'
import { countTokens, splitByTokens, MODEL_CONTEXT_LIMITS } from './tokenizer'
import type { ConvertOptions, ConvertResult } from '../types'

export { extractContent, getPageHTML, getSelectionHTML, htmlLooksLikeLoginWall } from './extractor'
export { htmlToMarkdown } from './markdown'
export { countTokens, splitByTokens, optimizeForContextWindow, MODEL_CONTEXT_LIMITS } from './tokenizer'
export type { TokenCount, ModelName, TargetAIModel } from './tokenizer'

/**
 * 将 HTML 转换为干净的 Markdown
 * 这是核心转换函数
 */
export function convertToMarkdown(
  html: string,
  options: ConvertOptions & { url?: string } = {}
): ConvertResult | null {
  // 1. 提取正文
  const extracted = extractContent(html, options.url, options.customRule)
  if (!extracted) {
    return null
  }

  // 2. 转换为 Markdown
  let markdown = htmlToMarkdown(extracted.content, options)

  // 3. 计算统计信息
  const { tokens, words, readingTime } = countTokens(markdown)
  // Original HTML token count — lets the UI show how much noise (nav, ads, HTML
  // markup) the conversion stripped out, framed as "you feed AI N fewer tokens".
  const { tokens: originalTokens } = countTokens(html)

  // 4. 添加元信息
  if (options.includeMeta) {
    const metaBlock = buildMetaBlock({
      title: extracted.title,
      url: options.url,
      extractedAt: new Date().toISOString(),
      author: extracted.author,
      published: extracted.published,
      description: extracted.description,
    })
    markdown = metaBlock + '\n\n' + markdown
  }

  return {
    markdown,
    metadata: {
      title: extracted.title,
      url: options.url,
      extractedAt: new Date().toISOString(),
      wordCount: words,
      tokenCount: tokens,
      originalTokenCount: originalTokens,
      readingTime,
      author: extracted.author,
      publishedDate: extracted.published,
      description: extracted.description,
    },
  }
}

/**
 * 构建元信息块（YAML frontmatter）
 */
function buildMetaBlock(meta: {
  title: string
  url?: string
  extractedAt: string
  author?: string
  published?: string
  description?: string
}): string {
  const lines = ['---']

  if (meta.title) {
    lines.push(`title: "${meta.title.replace(/"/g, '\\"')}"`)
  }
  if (meta.author) {
    lines.push(`author: "${meta.author.replace(/"/g, '\\"')}"`)
  }
  if (meta.published) {
    lines.push(`published: ${meta.published}`)
  }
  if (meta.description) {
    lines.push(`description: "${meta.description.replace(/"/g, '\\"')}"`)
  }
  if (meta.url) {
    lines.push(`source: ${meta.url}`)
  }
  lines.push(`date: ${meta.extractedAt}`)
  lines.push('---')

  return lines.join('\n')
}

/**
 * 快速转换（用于插件的一键转换）
 */
export function quickConvert(
  html: string,
  url?: string,
  options: Partial<ConvertOptions> = {}
): ConvertResult | null {
  return convertToMarkdown(html, {
    includeImages: true,
    includeLinks: true,
    includeMeta: true,
    detectCodeLanguage: true,
    url,
    ...options,
  })
}
