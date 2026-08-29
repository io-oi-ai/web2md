/**
 * web2md-core — HTML → clean, LLM-ready Markdown.
 *
 * This is the extraction and conversion engine that powers Web2MD. It is a
 * pure library: give it an HTML string, get Markdown back. No network calls,
 * no API keys, no account required — nothing here talks to a server.
 *
 * ```ts
 * import { convertToMarkdown } from 'web2md-core'
 *
 * const { markdown, metadata } = convertToMarkdown(html, 'https://example.com/post')
 * console.log(markdown)
 * console.log(metadata.originalTokenCount, '→', metadata.tokenCount)
 * ```
 */

export {
  /** Full conversion: extract main content, convert, and compute metadata. */
  convertToMarkdown,
  /** Convenience wrapper when you only want the Markdown string. */
  quickConvert,
  /** Extract the main content element from a document, dropping page furniture. */
  extractContent,
  /** Low-level HTML → Markdown, without content extraction. */
  htmlToMarkdown,
  /** Estimate token counts (the reason to convert in the first place). */
  countTokens,
  /** Split long Markdown into token-bounded chunks — useful for RAG ingestion. */
  splitByTokens,
  /** Trim content to fit a target model's context window. */
  optimizeForContextWindow,
  /** Detect pages that are really a login wall, so callers can fail loudly. */
  htmlLooksLikeLoginWall,
  MODEL_CONTEXT_LIMITS,
} from './converter'

// Browser-only helpers. They read `document` directly, so they throw in Node —
// exported separately to make that boundary explicit rather than surprising.
export { getPageHTML, getSelectionHTML } from './converter'

export type { TokenCount, ModelName, TargetAIModel } from './converter'

export type { ConvertOptions, ConvertResult, CustomRule } from './types'

/** Markdown → sanitized HTML (DOMPurify), for previewing converted output. */
export { renderMarkdownSync, renderMarkdownFull, renderMarkdownWithFormulas } from './markdown'
export type { TocItem, RenderOptions } from './markdown'
