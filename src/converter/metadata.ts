/**
 * 元数据多层降级提取
 * 借鉴 defuddle 的 MetadataExtractor，支持 Schema.org、Open Graph、Twitter Card、meta 标签等
 */

export interface PageMetadata {
  title: string
  author?: string
  published?: string
  description?: string
  image?: string
  siteName?: string
}

// --- Schema.org JSON-LD 解析 ---

function parseSchemaOrg(doc: Document): Record<string, unknown> | null {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]')
  for (const script of Array.from(scripts)) {
    try {
      const data = JSON.parse(script.textContent || '')
      // 可能是数组或单个对象
      if (Array.isArray(data)) {
        // 优先找 Article/NewsArticle/BlogPosting 类型
        const article = data.find(
          (d: Record<string, unknown>) =>
            typeof d['@type'] === 'string' &&
            /Article|NewsArticle|BlogPosting|WebPage|TechArticle|ScholarlyArticle/i.test(d['@type'] as string)
        )
        if (article) return article as Record<string, unknown>
        return data[0] as Record<string, unknown>
      }
      if (data && typeof data === 'object') {
        // @graph 格式
        if (Array.isArray(data['@graph'])) {
          const article = (data['@graph'] as Record<string, unknown>[]).find(
            (d) =>
              typeof d['@type'] === 'string' &&
              /Article|NewsArticle|BlogPosting|WebPage|TechArticle|ScholarlyArticle/i.test(d['@type'] as string)
          )
          if (article) return article
          return data['@graph'][0] as Record<string, unknown>
        }
        return data as Record<string, unknown>
      }
    } catch {
      // JSON parse error, try next script
    }
  }
  return null
}

function getSchemaProperty(schema: Record<string, unknown> | null, path: string): string {
  if (!schema) return ''
  const parts = path.split('.')
  let current: unknown = schema

  for (const part of parts) {
    if (current == null || typeof current !== 'object') return ''
    if (Array.isArray(current)) {
      // 取第一个元素
      current = current[0]
      if (current == null || typeof current !== 'object') return ''
    }
    current = (current as Record<string, unknown>)[part]
  }

  if (typeof current === 'string') return current
  if (current && typeof current === 'object' && 'name' in (current as Record<string, unknown>)) {
    return String((current as Record<string, unknown>).name || '')
  }
  if (current && typeof current === 'object' && 'url' in (current as Record<string, unknown>)) {
    return String((current as Record<string, unknown>).url || '')
  }
  if (Array.isArray(current)) {
    return current
      .map(item => (typeof item === 'string' ? item : (item && typeof item === 'object' && item.name) ? String(item.name) : ''))
      .filter(Boolean)
      .join(', ')
  }
  return current ? String(current) : ''
}

// --- Helper: 获取 meta 标签内容 ---

function getMeta(doc: Document, nameOrProp: string): string {
  const el =
    doc.querySelector(`meta[property="${nameOrProp}"]`) ||
    doc.querySelector(`meta[name="${nameOrProp}"]`)
  return el?.getAttribute('content')?.trim() || ''
}

// --- 月份映射 ---

const MONTH_MAP: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
}

/**
 * 自然语言日期解析：支持 "26 February 2025"、"February 26, 2025" 等
 */
function parseDateText(text: string): string {
  if (!text) return ''
  const cleaned = text.trim().replace(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s*/i, '')

  // "26 February 2025"
  const dmy = cleaned.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/)
  if (dmy && dmy[1] && dmy[2] && dmy[3]) {
    const month = MONTH_MAP[dmy[2].toLowerCase()]
    if (month) return `${dmy[3]}-${month}-${dmy[1].padStart(2, '0')}`
  }

  // "February 26, 2025"
  const mdy = cleaned.match(/(\w+)\s+(\d{1,2}),?\s+(\d{4})/)
  if (mdy && mdy[1] && mdy[2] && mdy[3]) {
    const month = MONTH_MAP[mdy[1].toLowerCase()]
    if (month) return `${mdy[3]}-${month}-${mdy[2].padStart(2, '0')}`
  }

  // ISO 8601: "2025-02-26" 或 "2025-02-26T..."
  const iso = cleaned.match(/(\d{4}-\d{2}-\d{2})/)
  if (iso && iso[1]) return iso[1]

  return ''
}

// --- 主提取函数 ---

/**
 * 提取页面元数据（多层降级策略）
 */
export function extractMetadata(doc: Document): PageMetadata {
  const schema = parseSchemaOrg(doc)

  return {
    title: extractTitle(doc, schema),
    author: extractAuthor(doc, schema) || undefined,
    published: extractPublished(doc, schema) || undefined,
    description: extractDescription(doc, schema) || undefined,
    image: extractImage(doc, schema) || undefined,
    siteName: extractSiteName(doc, schema) || undefined,
  }
}

// --- Title ---

function extractTitle(doc: Document, schema: Record<string, unknown> | null): string {
  const siteName = extractSiteName(doc, schema)

  const raw =
    getMeta(doc, 'og:title') ||
    getMeta(doc, 'twitter:title') ||
    getSchemaProperty(schema, 'headline') ||
    getMeta(doc, 'title') ||
    doc.querySelector('title')?.textContent?.trim() ||
    ''

  // 清除标题中的站点名称（如 "文章标题 - 站点名"）
  if (raw && siteName) {
    return raw
      .replace(new RegExp(`\\s*[|\\-–—]\\s*${escapeRegex(siteName)}\\s*$`), '')
      .replace(new RegExp(`^\\s*${escapeRegex(siteName)}\\s*[|\\-–—]\\s*`), '')
      .trim()
  }

  return raw
}

function escapeRegex(s: string): string {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

// --- Author ---

function extractAuthor(doc: Document, schema: Record<string, unknown> | null): string {
  // Step 1: Meta tags
  const metaAuthor =
    getMeta(doc, 'author') ||
    getMeta(doc, 'article:author') ||
    getMeta(doc, 'byl') ||
    getMeta(doc, 'sailthru.author')

  if (metaAuthor) return cleanAuthor(metaAuthor)

  // Step 2: Multi-value research paper meta tags
  const citationAuthors = Array.from(doc.querySelectorAll('meta[name="citation_author"]'))
    .map(el => el.getAttribute('content')?.trim() || '')
    .filter(Boolean)
    .map(name => {
      // "LastName, FirstName" → "FirstName LastName"
      const parts = name.split(',').map(s => s.trim())
      return parts.length === 2 ? `${parts[1]} ${parts[0]}` : name
    })
  if (citationAuthors.length) return citationAuthors.join(', ')

  const dcCreators = Array.from(doc.querySelectorAll('meta[name="dc.creator"], meta[name="DC.creator"]'))
    .map(el => el.getAttribute('content')?.trim() || '')
    .filter(Boolean)
  if (dcCreators.length) return dcCreators.join(', ')

  // Step 3: Schema.org author
  const schemaAuthor = getSchemaProperty(schema, 'author')
  if (schemaAuthor) return cleanAuthor(schemaAuthor)

  // Step 4: DOM selectors
  const authorSelectors = ['[itemprop="author"]', '.author-name', '[rel="author"]']
  for (const sel of authorSelectors) {
    try {
      const el = doc.querySelector(sel)
      if (el) {
        const text = el.textContent?.trim() || ''
        if (text && text.length < 100 && !/^authors?$/i.test(text)) {
          return cleanAuthor(text)
        }
      }
    } catch {
      // invalid selector
    }
  }

  // Step 5: Byline near <h1>
  const h1 = doc.querySelector('h1')
  if (h1) {
    let sibling = h1.nextElementSibling
    for (let i = 0; i < 3 && sibling; i++) {
      const text = sibling.textContent?.trim() || ''
      const bylineMatch = text.match(/^[Bb]y\s+(.+)$/)
      if (bylineMatch?.[1] && bylineMatch[1].length < 100) {
        return cleanAuthor(bylineMatch[1])
      }
      sibling = sibling.nextElementSibling
    }
  }

  return ''
}

function cleanAuthor(author: string): string {
  return author.replace(/^[Bb]y\s+/, '').trim()
}

// --- Published date ---

function extractPublished(doc: Document, schema: Record<string, unknown> | null): string {
  // Schema.org datePublished
  const schemaDate = getSchemaProperty(schema, 'datePublished')
  if (schemaDate) {
    const parsed = parseDateText(schemaDate)
    if (parsed) return parsed
  }

  // Meta tags
  const metaDate =
    getMeta(doc, 'article:published_time') ||
    getMeta(doc, 'publishDate') ||
    getMeta(doc, 'date') ||
    getMeta(doc, 'sailthru.date')
  if (metaDate) {
    const parsed = parseDateText(metaDate)
    if (parsed) return parsed
  }

  // <time> element
  const timeEl = doc.querySelector('time[datetime], time[pubdate], abbr[itemprop="datePublished"]')
  if (timeEl) {
    const dt = timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || timeEl.textContent?.trim() || ''
    const parsed = parseDateText(dt)
    if (parsed) return parsed
  }

  // Natural language date from siblings after <h1>
  const h1 = doc.querySelector('h1')
  if (h1) {
    let sibling = h1.nextElementSibling
    for (let i = 0; i < 3 && sibling; i++) {
      const text = sibling.textContent?.trim() || ''
      if (text.length < 100) {
        const parsed = parseDateText(text)
        if (parsed) return parsed
      }
      sibling = sibling.nextElementSibling
    }
  }

  return ''
}

// --- Description ---

function extractDescription(doc: Document, schema: Record<string, unknown> | null): string {
  return (
    getMeta(doc, 'description') ||
    getMeta(doc, 'og:description') ||
    getSchemaProperty(schema, 'description') ||
    getMeta(doc, 'twitter:description') ||
    getMeta(doc, 'sailthru.description') ||
    ''
  )
}

// --- Image ---

function extractImage(doc: Document, schema: Record<string, unknown> | null): string {
  return (
    getMeta(doc, 'og:image') ||
    getMeta(doc, 'twitter:image') ||
    getSchemaProperty(schema, 'image') ||
    ''
  )
}

// --- Site name ---

function extractSiteName(doc: Document, schema: Record<string, unknown> | null): string {
  return (
    getSchemaProperty(schema, 'publisher.name') ||
    getMeta(doc, 'og:site_name') ||
    getMeta(doc, 'application-name') ||
    ''
  )
}
