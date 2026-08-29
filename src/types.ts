/**
 * Public types for web2md-core.
 *
 * Deliberately minimal: only what the converter surface needs. Plan limits,
 * quota rules, and anything else product-specific stay in the closed-source
 * app — this package is about turning HTML into Markdown, nothing else.
 */

/** A site-specific extraction rule. */
export interface CustomRule {
  /** Human-readable rule name. */
  name: string
  /** Domain this rule applies to, e.g. "example.com". */
  domain: string
  /** CSS selector for the main content container. */
  contentSelector: string
  /** Selectors to strip before conversion (ads, nav, related-posts, …). */
  removeSelectors?: string[]
  /** Optional selector for the title, when the page's <title> is unhelpful. */
  titleSelector?: string
}

export interface ConvertOptions {
  /**
   * Keep images. **Defaults to false** — omitting this strips them.
   * Images cost tokens and are usually noise when feeding an LLM, so the
   * default favours the primary use case. Pass `true` to keep them.
   */
  includeImages?: boolean
  /**
   * Keep links. **Defaults to false** — omitting this flattens `<a>` to text.
   * Same reasoning as images: link URLs are often the bulk of the tokens in
   * navigation-heavy pages. Pass `true` to keep them.
   */
  includeLinks?: boolean
  /** Prepend a metadata block (source URL, timestamp, …). Default: false. */
  includeMeta?: boolean
  /** Site-specific extraction rule to apply. */
  customRule?: CustomRule
  /** Try to infer the language of fenced code blocks. */
  detectCodeLanguage?: boolean
}

export interface ConvertResult {
  /** The converted Markdown. */
  markdown: string
  metadata: {
    title: string
    url?: string
    /** ISO timestamp of when extraction ran. */
    extractedAt: string
    wordCount: number
    /** Estimated tokens for the cleaned Markdown. */
    tokenCount: number
    /**
     * Estimated tokens for the raw HTML, so callers can show how much the
     * cleanup saved. This is the number that makes the case for converting
     * at all: HTML markup is a large share of what an LLM would otherwise read.
     */
    originalTokenCount?: number
    /** Estimated reading time in minutes. */
    readingTime: number
    author?: string
    publishedDate?: string
    description?: string
  }
}
