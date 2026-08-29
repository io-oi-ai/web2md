import { parseHTML } from 'linkedom'
import type { CustomRule } from '../types'
import { extractMetadata } from './metadata'

export interface ExtractResult {
  title: string
  content: string
  excerpt?: string
  byline?: string
  siteName?: string
  author?: string
  published?: string
  description?: string
  image?: string
}

/**
 * 从 HTML 中提取正文内容
 * 语义优先策略：精确 CMS 选择器 → HTML5 语义标签 → body 兜底
 */
export function extractContent(
  html: string,
  url?: string,
  customRule?: CustomRule
): ExtractResult | null {
  console.log('[Extractor] Starting extraction, HTML length:', html.length)

  // 规范化 HTML
  let htmlToParse = html
  if (!html.trim().toLowerCase().startsWith('<!doctype') && !html.trim().toLowerCase().startsWith('<html')) {
    htmlToParse = `<!DOCTYPE html><html><head></head><body>${html}</body></html>`
  }

  // 解析 HTML
  let doc: Document
  try {
    const result = parseHTML(htmlToParse)
    doc = result.document
    console.log('[Extractor] linkedom parsed successfully')
  } catch (parseError) {
    console.error('[Extractor] linkedom parse error:', parseError)
    throw parseError
  }

  if (!doc || !doc.documentElement) {
    console.error('[Extractor] Invalid document: missing documentElement')
    return null
  }

  // 如果有自定义规则，使用自定义选择器
  if (customRule) {
    return extractWithCustomRule(doc, customRule)
  }

  // 在清洗前提取元数据（需要完整 DOM）
  const meta = extractMetadata(doc)

  // 删除 script/style/noscript（安全的标签名删除，不影响内容）
  for (const el of Array.from(doc.querySelectorAll('script, style, noscript'))) el.remove()

  // 移除隐藏元素（display:none、visibility:hidden、hidden 属性等）
  removeHiddenElements(doc)

  // 规范化假标题为真实 <hN> 标签
  normalizeHeadings(doc)
  // 清除代码块内的污染元素（copy button、行号、工具栏）
  cleanCodeBlocks(doc)
  // 展开 tab panel 隐藏内容（文档网站的多语言代码示例）
  expandTabPanels(doc)

  // 使用元数据中的 title（已清理站点名称），回退到 <title> 标签
  const title = meta.title || doc.querySelector('title')?.textContent?.trim() || ''

  // 第一次尝试（完整清洗）
  const result = tryExtract(doc, title, true)
  if (result && (result.content.length || 0) > 0) {
    const textLen = doc.createElement('div')
    textLen.innerHTML = result.content
    const len = textLen.textContent?.trim().length || 0
    if (len >= RETRY_THRESHOLD) {
      return { ...result, ...metaFields(meta) }
    }
    // 提取量不足，降级重试（关闭模糊匹配）
    console.log('[Extractor] Content too short (' + len + ' chars), retrying without partial selectors')
  }

  // 降级重试：重新解析 HTML，只用精确选择器清洗
  const retryResult = parseHTML(htmlToParse)
  const retryDoc = retryResult.document
  for (const el of Array.from(retryDoc.querySelectorAll('script, style, noscript'))) el.remove()
  removeHiddenElements(retryDoc)
  normalizeHeadings(retryDoc)
  cleanCodeBlocks(retryDoc)
  expandTabPanels(retryDoc)

  const fallback = tryExtract(retryDoc, title, false)
  if (fallback) {
    // Pick whichever result has more content
    if (result) {
      const origLen = result.content.replace(/<[^>]*>/g, '').trim().length
      const retryLen = fallback.content.replace(/<[^>]*>/g, '').trim().length
      const best = retryLen > origLen ? fallback : result
      console.log('[Extractor] Retry succeeded, using', retryLen > origLen ? 'relaxed' : 'original', 'result')
      return { ...best, ...metaFields(meta) }
    }
    console.log('[Extractor] Retry succeeded with relaxed cleaning')
    return { ...fallback, ...metaFields(meta) }
  }

  // Even if content is short, return it rather than null (some content > no content)
  if (result) {
    console.log('[Extractor] Returning short content rather than failing')
    return { ...result, ...metaFields(meta) }
  }

  return null
}

/** 提取量低于此阈值时触发降级重试 */
const RETRY_THRESHOLD = 200

/** 将 PageMetadata 映射为 ExtractResult 的可选字段 */
function metaFields(meta: { author?: string; published?: string; description?: string; image?: string; siteName?: string }) {
  return {
    author: meta.author,
    published: meta.published,
    description: meta.description,
    image: meta.image,
    siteName: meta.siteName,
  }
}

// Tier 1: CMS 精确选择器（这些选择器已知精准对应正文容器）
const tier1Selectors = [
  '#js_content',          // 微信公众号
  '.rich_media_content',  // 微信公众号（备选）
  '.available-content',   // Substack 主内容
  '.body.markup',         // Substack 文章正文
  '.gh-content',          // Ghost 平台
  '.content-fragment-content', // Telligent 社区平台 (guildsomm.com 等) wiki/文章正文
  '.markdown-body',       // GitHub / 各类 Markdown 渲染
  '.prose',               // Tailwind Typography / Mintlify docs
  '.rm-Article',          // ReadMe docs (platform.openai.com, etc.)
  '.rdmd-content',        // ReadMe markdown content
  '.post-content',
  '.article-content',
  '.entry-content',
  '.article__content',    // 新闻网站变体
  '.story-body',          // BBC, news sites
  '.article-body',        // 各类新闻
  '.post-body',           // 博客
  '.page-content',        // CMS 通用
  '.main-content',        // 通用
  '.content-body',        // 通用
  '.blog-post',           // 博客
  '[itemprop="articleBody"]', // Schema.org 语义标记
  '[data-article-body]',  // 数据属性
  '.notion-page-content', // Notion public pages
  '.s-prose',             // Stack Overflow answer body
  '.crayons-article__body', // Dev.to
  '.caas-body',           // Yahoo News
  '#mw-content-text',     // Wikipedia / MediaWiki
]

// Tier 2: HTML5 语义标签
const tier2Selectors = [
  'main',
  'article',
  '[role="main"]',
  '[role="article"]',
]

// Tier 3: 通用 id/class（需要 200 字符保护以防空壳）
const tier3Selectors = [
  '#content',
  '.content',
  '#main',
  '#main-content',
  '#primaryContent',
  '#article',
  '.wrapper',
]

const MIN_CHARS = 200

/**
 * 尝试从 doc 中提取内容
 * @param usePartialSelectors 是否使用模糊匹配清洗
 */
function tryExtract(
  doc: Document,
  title: string,
  usePartialSelectors: boolean
): Omit<ExtractResult, 'author' | 'published' | 'description' | 'image' | 'siteName'> | null {
  for (const selector of [...tier1Selectors, ...tier2Selectors, ...tier3Selectors]) {
    try {
      // 同一选择器的所有命中里取"文本量最大"的(> MIN_CHARS 起判)。
      // 两代教训:querySelector 首个命中会被 Telligent(guildsomm.com)满页的
      // 空 "layout-region content" 容器挡住;"文档序第一个非空"又会命中同
      // class 的导航菜单碎片(菜单 ~600 字符,真正文 22000+ 字符) —— 最大
      // 文本量在两类页面上都稳定选中正文。
      let best: Element | null = null
      let bestLen = MIN_CHARS
      for (const el of Array.from(doc.querySelectorAll(selector))) {
        const len = el.textContent?.trim().length ?? 0
        if (len > bestLen) {
          best = el
          bestLen = len
        }
      }
      if (best) {
        console.log('[Extractor] Found content with selector:', selector, 'length:', bestLen)
        removeClutter(best, usePartialSelectors)
        standardizeHeadings(best, title)
        return { title, content: best.innerHTML }
      }
    } catch {
      // 忽略无效选择器
    }
  }

  // Body 兜底：删除导航/页眉/页脚等干扰区域，返回剩余内容
  console.log('[Extractor] No semantic container found, using body fallback')
  const body = doc.querySelector('body')
  if (!body || !body.textContent?.trim()) {
    console.log('[Extractor] Empty body, extraction failed')
    return null
  }

  // 只移除明确的非内容区域
  for (const el of Array.from(body.querySelectorAll(
    'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]'
  ))) el.remove()

  // Body fallback 用精确选择器清洗（不用模糊匹配，避免误删正文）
  removeClutter(body, false)
  standardizeHeadings(body, title)

  const bodyText = body.textContent?.trim() || ''
  if (bodyText.length === 0) {
    console.log('[Extractor] Body empty after cleanup, extraction failed')
    return null
  }

  console.log('[Extractor] Using body fallback, length:', bodyText.length)
  return { title, content: body.innerHTML }
}

/**
 * 使用自定义规则提取内容
 */
function extractWithCustomRule(doc: Document, rule: CustomRule): ExtractResult | null {
  // 移除不需要的元素
  if (rule.removeSelectors) {
    for (const selector of rule.removeSelectors) {
      const elements = Array.from(doc.querySelectorAll(selector))
      for (const el of elements) el.remove()
    }
  }

  // 获取正文
  const contentEl = doc.querySelector(rule.contentSelector)
  if (!contentEl) {
    return null
  }

  // 获取标题
  let title = ''
  if (rule.titleSelector) {
    const titleEl = doc.querySelector(rule.titleSelector)
    title = titleEl?.textContent?.trim() || ''
  }
  if (!title) {
    title = doc.querySelector('title')?.textContent?.trim() || ''
  }

  return {
    title,
    content: contentEl.innerHTML,
  }
}

/**
 * 将伪装成标题的元素（role=heading 或 class=hN）规范化为真实 <hN> 标签
 * 保守策略：只处理有明确 ARIA 语义或精确 class="hN" 模式的元素
 */
export function normalizeHeadings(doc: Document): void {
  // 策略 1: role="heading" + aria-level
  for (const el of Array.from(doc.querySelectorAll('[role="heading"]'))) {
    const level = parseInt(el.getAttribute('aria-level') || '2', 10)
    const safeLevel = Math.min(Math.max(level, 1), 6)
    const hEl = doc.createElement(`h${safeLevel}`)
    hEl.innerHTML = el.innerHTML
    el.parentNode?.replaceChild(hEl, el)
  }

  // 策略 2: class 中包含独立的 h1–h6 token（如 class="h2" 或 class="h3 mb-4"）
  for (let n = 1; n <= 6; n++) {
    // 用属性选择器匹配 class 列表中的精确单词，避免误匹配 h2-title 等复合词
    for (const el of Array.from(doc.querySelectorAll(`[class~="h${n}"]`))) {
      // 跳过已经是真实标题的元素
      if (/^H[1-6]$/.test(el.tagName)) continue
      const hEl = doc.createElement(`h${n}`)
      hEl.innerHTML = el.innerHTML
      el.parentNode?.replaceChild(hEl, el)
    }
  }
}

/**
 * 清除 <pre> 内的非代码污染元素：copy button、行号、工具栏等
 */
export function cleanCodeBlocks(doc: Document): void {
  const JUNK_SELECTORS = [
    'button',
    '[class*="copy"]',
    '[class*="toolbar"]',
    '[class*="line-number"]',
    '[class*="linenumber"]',
    '[class*="gutter"]',
    '[aria-label="Copy"]',
    '[aria-label="copy"]',
  ]

  for (const pre of Array.from(doc.querySelectorAll('pre'))) {
    for (const sel of JUNK_SELECTORS) {
      for (const junk of Array.from(pre.querySelectorAll(sel))) junk.remove()
    }
  }
}

/**
 * 展开 tab panel 组件中被隐藏的内容面板
 * 覆盖：Docusaurus tabs、VitePress code-group、通用 role=tabpanel
 */
export function expandTabPanels(doc: Document): void {
  // 通用：移除所有 role=tabpanel 元素上的 hidden 属性
  for (const panel of Array.from(doc.querySelectorAll('[role="tabpanel"]'))) {
    panel.removeAttribute('hidden')
    ;(panel as HTMLElement).style.display = ''
    panel.classList.remove('hidden', 'is-hidden', 'tab-hidden', 'inactive')
  }

  // Docusaurus: .tabs__content[hidden]
  for (const panel of Array.from(doc.querySelectorAll('.tabs__content[hidden], .tabs__content.hidden'))) {
    panel.removeAttribute('hidden')
    panel.classList.remove('hidden')
  }

  // VitePress: .vp-code-group .blocks > div
  for (const panel of Array.from(doc.querySelectorAll('.vp-code-group .blocks > div'))) {
    ;(panel as HTMLElement).style.display = ''
    panel.removeAttribute('hidden')
  }
}

/**
 * 文本相似度计算（bigram 方式）
 */
function textSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  const longer = a.length > b.length ? a : b
  const shorter = a.length > b.length ? b : a
  if (longer.includes(shorter)) return shorter.length / longer.length
  const getBigrams = (s: string) => {
    const bigrams = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) bigrams.add(s.slice(i, i + 2))
    return bigrams
  }
  const bg1 = getBigrams(a)
  const bg2 = getBigrams(b)
  let intersection = 0
  bg1.forEach(bg => { if (bg2.has(bg)) intersection++ })
  return (2 * intersection) / (bg1.size + bg2.size)
}

/**
 * 标题去重 + H1→H2 降级
 * 1. 删除与 title 重复的第一个 h1/h2
 * 2. 将所有剩余 h1 降级为 h2
 */
export function standardizeHeadings(root: Element | Document, title: string): void {
  if (!title) return
  const normalizedTitle = title.toLowerCase().trim()
  const ownerDoc = 'ownerDocument' in root && root.ownerDocument ? root.ownerDocument : root as Document

  // 删除与 title 重复的第一个 h1/h2
  for (const tag of ['h1', 'h2']) {
    const heading = root.querySelector(tag)
    if (heading) {
      const headingText = heading.textContent?.toLowerCase().trim() || ''
      if (headingText && (
        normalizedTitle.includes(headingText) ||
        headingText.includes(normalizedTitle) ||
        textSimilarity(headingText, normalizedTitle) > 0.8
      )) {
        heading.remove()
        break
      }
    }
  }

  // H1 → H2 降级
  for (const h1 of Array.from(root.querySelectorAll('h1'))) {
    const h2 = ownerDoc.createElement('h2')
    h2.innerHTML = h1.innerHTML
    h1.parentNode?.replaceChild(h2, h1)
  }
}

/**
 * 移除隐藏元素：hidden 属性、aria-hidden、内联 display:none / visibility:hidden
 */
export function removeHiddenElements(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll('[hidden], [aria-hidden="true"]'))) el.remove()

  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    const style = (el as HTMLElement).getAttribute('style') || ''
    if (
      /display\s*:\s*none/i.test(style) ||
      /visibility\s*:\s*hidden/i.test(style)
    ) {
      el.remove()
    }
  }
}

// --- 精确选择器：直接匹配 CSS 选择器，移除匹配元素 ---
// 借鉴 defuddle，按类别组织，保护数学元素
const EXACT_SELECTORS = [
  // Ads
  '.ad:not([class*="gradient"])',
  '[class^="ad-" i]', '[class$="-ad" i]',
  '[id^="ad-" i]', '[id$="-ad" i]',
  '.ads', '.advert', '.advertisement', '.ad-container',
  '[role="banner" i]', '[alt*="advert" i]',
  '.promo', '.Promo',

  // Alerts
  '.alert',

  // Comments
  '[id="comments" i]', '[id="comment" i]',
  '.comments', '.comment-section', '#disqus_thread',

  // Header / Nav
  'header', '.header:not(.banner)', '#header', '#Header',
  '#banner', '#Banner',
  'nav', '.navigation', '#navigation',
  '.hero',
  '[role="navigation" i]', '[role="dialog" i]', '[role*="complementary" i]',
  '[class*="pagination" i]',
  '.menu', '#menu',
  '#siteSub', '.previous',

  // Metadata elements
  '.author', '.Author', '[class$="_bio"]',
  '#categories', '.contributor',
  '.date', '#date', '[data-date]',
  '.entry-meta', '.meta',
  '.tags', '#tags',
  '.toc', '.Toc', '#toc',
  '.headline', '#headline',
  '#title', '#Title', '#articleTag',
  '[href*="/category"]', '[href*="/categories"]',
  '[href*="/tag/"]', '[href*="/tags/"]', '[href*="/topics"]',
  '[href*="author"]', '[href*="#toc"]',
  '[href="#top"]', '[href="#Top"]',
  '[href="#page-header"]', '[href="#content"]',
  '[href="#site-content"]', '[href="#main-content"]',
  '[href^="#main"]',
  '[src*="author"]',

  // Footer
  'footer',

  // Inputs and UI elements
  '.aside', 'aside:not([class*="callout"])',
  'button', 'canvas', 'dialog', 'fieldset', 'form',
  'input:not([type="checkbox"])',
  'label', 'option', 'select', 'textarea',
  'time', 'relative-time',

  // Hidden elements (with math protection)
  '[hidden]',
  '[aria-hidden="true"]:not([class*="math"])',
  '[style*="display: none"]:not([class*="math"])',
  '[style*="display:none"]:not([class*="math"])',
  '[style*="visibility: hidden"]', '[style*="visibility:hidden"]',
  '.hidden', '.invisible',

  // Iframes (keep YouTube/Vimeo/Twitter/Datawrapper)
  'iframe:not([src*="youtube"]):not([src*="youtu.be"]):not([src*="vimeo"]):not([src*="twitter"]):not([src*="x.com"]):not([src*="datawrapper"])',

  // Logos
  '[class="logo" i]', '#logo', '#Logo',

  // Newsletter / Subscribe
  '#newsletter', '#Newsletter', '.subscribe', '.subscribe-form', '.signup',

  // Print-hidden
  '.noprint', '[data-print-layout="hide" i]', '[data-block="donotprint" i]',

  // Footnote anchors (not the footnote content itself)
  '[class*="clickable-icon" i]',
  'a[href^="#"][class*="anchor" i]',

  // Link lists
  '[data-container*="most-viewed" i]',

  // Sidebar
  '.sidebar', '.Sidebar', '#sidebar', '#Sidebar', '#sitesub',
  '.widget', '.widget-area',

  // Skip links
  '[data-link-name*="skip" i]', '[aria-label*="skip" i]',

  // Social / sharing
  '.social-share', '.share-buttons', '.sharing', '.share-links',

  // Related content
  '.related-posts', '.related-articles', '.recommended',

  // Popups / overlays
  '.popup', '.modal', '.overlay',
  '.cookie-banner', '.cookie-consent', '.consent-banner',

  // Other / site-specific
  '.copyright', '#copyright',
  '#rss', '#feed', '.gutter',
  'table.infobox',
  '.pencraft:not(.pc-display-contents)',  // Substack
  '[data-optimizely="related-articles-section" i]', // The Economist
  '[data-orientation="vertical"]',
  '.gh-header-sticky', // GitHub
  '[data-testid="issue-metadata-sticky"]', // GitHub
].join(', ')

// --- 模糊匹配模式：检查 class/id 中是否包含这些子串 ---
// 合并为单个正则以提高性能，借鉴 defuddle 的 partial selectors
const CLUTTER_PARTIAL_PATTERNS = [
  // Ads
  'advert', 'ad-placement', 'ads-container', '_ad_', 'ad-tldr',
  // Article metadata
  'article-author', 'article-banner', 'article-bottom', 'article-category',
  'article-date', 'article-header', 'article-hero', 'article-info',
  'article-meta', 'article-subject', 'article-tags', 'article-title',
  'article-topics',
  // Author
  'author-bio', 'author-box', 'author-info', 'author-name', 'authored-by',
  // Navigation
  'back-to-top', 'breadcrumb', 'bottomnav', 'bottom-of-article',
  // Buttons
  'btn-', '-btn', 'button-wrapper', 'buttons-container',
  // Byline
  'byline',
  // Categories
  'catlinks', '_categories',
  // Comments
  'comment-button', 'comment-content', 'comment-count',
  'comment-form', 'comment-respond', 'comment-thread', 'comment-wrap',
  // Content promo
  'content-card', 'content-topics', 'contentpromo',
  // CTA
  '_cta', '-cta', 'cta-', 'cta_',
  // Date
  'dateline', 'dateheader', 'date-header', 'date-pub',
  // Discussion
  'disclaimer', 'disclosure', 'discussion', 'disqus',
  // Donate
  'donate', 'donation',
  // Dropdown
  'dropdown',
  // Email
  'emailsignup',
  // Entry meta
  'entry-author', 'entry-categories', 'entry-date', 'entry-title', 'entry-utility',
  // Footer
  'footer',
  // Further reading
  'further-reading',
  // Hamburger
  'hamburger',
  // Header
  'header-logo', 'header-pattern',
  // Hide for print
  'hide-for-print', 'hide-print', 'hidden-print', 'noprint', 'print-none',
  // Invisible / hidden
  'invisible', 'visually-hidden', 'sr-only', 'u-hide',
  // Keep reading / read more
  'keepreading', 'keep-reading', 'readmore', 'read-next',
  // Kicker
  'kicker',
  // Logo
  'logo_container',
  // Masthead
  'masthead',
  // Marketing
  'marketing',
  // Menu
  '-menu', 'menu-',
  // Metadata
  'metadata',
  // Modal
  '-modal', '_modal',
  // More stories
  'more-about', 'morenews', 'morestories', 'most-read',
  // Nav
  'nav-', 'nav_', 'navigation-post',
  // Newsletter
  'newsletter_', 'newsletterbanner', 'newsletter-form',
  'newsletter-signup', 'newslettersignup', 'newsletterwrapper',
  // Page header
  'pagehead', 'page-header', 'page-title',
  // Paywall
  'paywall_message',
  // Popular / trending
  'popular', 'trending',
  // Post meta
  'post-author', 'post-bottom', 'postcomment', 'postdate',
  'post-date', 'post-details', 'post-feeds', 'postinfo',
  'post-info', 'post-links', 'postlist', 'post-meta', 'postmeta',
  'post-navigation', 'post-preview', 'postsnippet',
  'post-subject', 'posttax', 'post-tag', 'post-title', 'posttitle',
  // Prev/next
  'prev-post', 'prevnext', 'prev-next', 'previousnext',
  // Privacy
  'privacy-notice', 'privacy-settings',
  // Profile
  'profile',
  // Promo
  'promo-bar', 'promo-box',
  // Publish date
  'pubdate', 'pub-date', 'publish-date', 'publication-date',
  // QR
  'qr-code', 'qr_code',
  // Reading time
  'read-time', 'reading-time', 'reading_time',
  // Recent
  'recent-articles', 'recentpost', 'recent-post',
  // Recommend / related / recirc
  'recommend', 'recirc', 'related', 'relevant',
  // RSS
  '_rss', 'rss-link',
  // Screen reader
  'screen-reader-text',
  // Search
  '_search', '-search',
  // Share
  'share-box', 'sharedaddy', 'share-icons', 'sharelinks',
  'share-post', 'share-section',
  // Sidebar
  'sidebar-content', 'sidebar-wrapper', 'sideitems', 'sidebar-author',
  'sidebar-item', 'side-box',
  // Sign in
  'sign-in-gate',
  // Similar
  'similar-', 'similar_',
  // Site header
  'site-header', 'siteheader', 'site-logo', 'site-name',
  // Skip
  'skip-content', 'skip-to-content', 'skip-link',
  // Social
  'social-author', 'social-shar', 'social-date',
  // Sponsor
  'sponsor',
  // Subscribe
  '-subscribe-', 'subscription-',
  // Tags
  '_tags', 'tag_list', 'taxonomy',
  // Table of contents
  'table-of-contents', 'toc-container',
  // Timestamp
  'timestamp', 'time-read', 'time-to-read',
  // Tooltip / topbar
  'tooltip', 'topbar',
  // Topic
  'topic-list', 'topic-subnav',
  // Twitter / Facebook
  'twitter', 'facebook',
  // Upsell
  'upsell',
  // Widget
  'widget_pages',
  // Consent
  'consent', 'cookie',
  // Wiki-specific
  'mw-editsection', 'mw-cite-backlink', 'mw-indicators', 'mw-jump-link',
]

// 预编译为单个正则（性能优化）
const CLUTTER_PATTERN = new RegExp(
  CLUTTER_PARTIAL_PATTERNS.map(p => p.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')).join('|'),
  'i'
)

/**
 * 移除杂项元素：社交分享、广告、评论区、弹窗等非正文内容
 * @param usePartialSelectors 是否启用模糊匹配（降级重试时可关闭）
 */
export function removeClutter(root: Element | Document, usePartialSelectors = true): void {
  // 精确选择器匹配
  for (const el of Array.from(root.querySelectorAll(EXACT_SELECTORS))) el.remove()

  if (!usePartialSelectors) return

  // 模糊匹配 class/id（只删除内容较少的块，避免误删）
  // 检查 7 种属性，与 defuddle 的 TEST_ATTRIBUTES 一致
  for (const el of Array.from(root.querySelectorAll('div, section, aside, footer, span, ul, ol'))) {
    const attrs = [
      (el as HTMLElement).className || '',
      (el as HTMLElement).id || '',
      el.getAttribute('data-test') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('data-test-id') || '',
      el.getAttribute('data-qa') || '',
      el.getAttribute('data-cy') || '',
    ].join(' ')
    if (CLUTTER_PATTERN.test(attrs)) {
      if ((el.textContent?.trim().length || 0) < 200) {
        el.remove()
      }
    }
  }
}

/**
 * 从浏览器获取当前页面 HTML（Content Script 使用）
 */
/**
 * 判断 HTML 是否带登录墙/会员墙标记(只看 class 属性,不误伤 script 里的
 * "paywall" 配置字样)。供 /api/convert 在提取失败时区分"登录墙"和"结构
 * 复杂",给用户明确指引而不是笼统报错。Telligent 平台(guildsomm.com)未登
 * 录时用 logged_out_member_content 容器替换会员正文。
 */
export function htmlLooksLikeLoginWall(html: string): boolean {
  // no-access/upsell-login: fd.nl 2026-07 起的无权限标记(JSON-LD articleBody 已撤)
  return /class="[^"]*(?:logged_out_member_content|paywall|members-only|member-only|registration-wall|regwall|login-wall|subscription-required|no-access|upsell-login)[^"]*"/i.test(
    html
  )
}

export function getPageHTML(): string {
  return document.documentElement.outerHTML
}

/**
 * 获取选中文本的 HTML
 */
export function getSelectionHTML(): string | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return null
  }

  const range = selection.getRangeAt(0)
  const container = document.createElement('div')
  container.appendChild(range.cloneContents())

  return container.innerHTML
}
