/**
 * markdown-renderer.ts
 * Core Markdown rendering logic for Web2MD preview features.
 * Supports: GFM, syntax highlighting, KaTeX math, Mermaid diagrams, ToC.
 */

import { marked, type Renderer } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'

// Register common languages (subset to keep bundle small)
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import sql from 'highlight.js/lib/languages/sql'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import c from 'highlight.js/lib/languages/c'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('yml', yaml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('css', css)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', c)
hljs.registerLanguage('php', php)
hljs.registerLanguage('ruby', ruby)
hljs.registerLanguage('rb', ruby)
hljs.registerLanguage('swift', swift)
hljs.registerLanguage('kotlin', kotlin)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('md', markdown)
hljs.registerLanguage('diff', diff)

export interface TocItem {
  level: 1 | 2 | 3
  text: string
  id: string
}

export interface RenderOptions {
  theme?: 'dark' | 'light'
  enableMath?: boolean
  enableMermaid?: boolean
}

// Cached KaTeX module
let katexModule: typeof import('katex') | null = null

async function loadKatex() {
  if (!katexModule) {
    katexModule = await import('katex')
  }
  return katexModule
}

// Generate slug ID for heading anchors
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim()
}

// Extract formula placeholders before marked parses (prevent $ conflicts with em)
interface FormulaEntry {
  display: boolean
  formula: string
}

function extractFormulas(md: string): { processed: string; formulas: Map<string, FormulaEntry> } {
  const formulas = new Map<string, FormulaEntry>()
  let counter = 0

  // Display math: $$...$$
  let processed = md.replace(/\$\$([^$]+?)\$\$/gs, (_match, formula) => {
    const key = `__FORMULA_BLOCK_${counter++}__`
    formulas.set(key, { display: true, formula: formula.trim() })
    return key
  })

  // Inline math: $...$ (not $$ and not inside code)
  processed = processed.replace(/\$([^$\n]+?)\$/g, (_match, formula) => {
    // Skip if it looks like a currency value (e.g. $9, $100)
    if (/^\d/.test(formula.trim())) return _match
    const key = `__FORMULA_INLINE_${counter++}__`
    formulas.set(key, { display: false, formula: formula.trim() })
    return key
  })

  return { processed, formulas }
}

async function fillFormulas(html: string, formulas: Map<string, FormulaEntry>): Promise<string> {
  if (formulas.size === 0) return html

  let katex: typeof import('katex')
  try {
    katex = await loadKatex()
  } catch {
    return html
  }

  let result = html
  for (const [key, { display, formula }] of formulas) {
    try {
      const rendered = katex.default.renderToString(formula, {
        displayMode: display,
        throwOnError: false,
        output: 'html',
      })
      result = result.replace(key, rendered)
    } catch {
      result = result.replace(key, `<code>${formula}</code>`)
    }
  }
  return result
}

// Build the marked renderer with hljs + mermaid placeholder support
function buildRenderer(enableMermaid: boolean): Partial<Renderer> {
  return {
    code({ text, lang }) {
      const language = lang || ''
      if (language === 'mermaid' && enableMermaid) {
        const encoded = encodeURIComponent(text)
        return `<div class="mermaid-placeholder" data-src="${encoded}"><pre class="mermaid-source">${text}</pre></div>`
      }
      if (language && hljs.getLanguage(language)) {
        try {
          const highlighted = hljs.highlight(text, { language }).value
          return `<pre><code class="hljs language-${language}" data-highlighted="yes">${highlighted}</code></pre>`
        } catch {
          // fall through
        }
      }
      // Auto-detect
      try {
        const result = hljs.highlightAuto(text)
        return `<pre><code class="hljs" data-highlighted="yes">${result.value}</code></pre>`
      } catch {
        return `<pre><code>${text}</code></pre>`
      }
    },

    heading({ text, depth }) {
      const id = slugify(text.replace(/<[^>]+>/g, ''))
      return `<h${depth} id="${id}">${text}</h${depth}>\n`
    },
  }
}

/**
 * Synchronous render — for popup preview (no Mermaid, KaTeX loaded async in component)
 */
export function renderMarkdownSync(md: string, _options: RenderOptions = {}): string {
  // Strip frontmatter
  const stripped = md.replace(/^---[\s\S]*?---\n*/m, '')

  // Extract formulas (sync: leave placeholders in output, component fills async)
  const { processed } = extractFormulas(stripped)

  const renderer = buildRenderer(false)
  marked.use({ renderer, gfm: true, breaks: false })

  const html = marked.parse(processed) as string

  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['class', 'id', 'data-src', 'data-highlighted', 'target', 'rel'],
    ADD_TAGS: ['math', 'mfrac', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'msubsup', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'annotation', 'semantics'],
    ALLOW_DATA_ATTR: true,
  })
}

/**
 * Synchronous render with formula extraction — returns both HTML and formula map
 * Used by MarkdownPreview component for async KaTeX filling
 */
export function renderMarkdownWithFormulas(md: string, _options: RenderOptions = {}): { html: string; formulas: Map<string, FormulaEntry> } {
  const stripped = md.replace(/^---[\s\S]*?---\n*/m, '')
  const { processed, formulas } = extractFormulas(stripped)

  const renderer = buildRenderer(false)
  marked.use({ renderer, gfm: true, breaks: false })

  const html = marked.parse(processed) as string

  const sanitized = DOMPurify.sanitize(html, {
    ADD_ATTR: ['class', 'id', 'data-src', 'data-highlighted', 'target', 'rel'],
    ADD_TAGS: ['math', 'mfrac', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'msubsup', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'annotation', 'semantics'],
    ALLOW_DATA_ATTR: true,
  })

  return { html: sanitized, formulas }
}

/**
 * Fill formula placeholders after KaTeX is loaded
 */
export { fillFormulas }

/**
 * Async full render — for preview tab (with Mermaid + KaTeX)
 */
export async function renderMarkdownFull(md: string, options: RenderOptions = {}): Promise<string> {
  const stripped = md.replace(/^---[\s\S]*?---\n*/m, '')
  const { processed, formulas } = extractFormulas(stripped)

  const enableMermaid = options.enableMermaid !== false
  const renderer = buildRenderer(enableMermaid)
  marked.use({ renderer, gfm: true, breaks: false })

  const html = marked.parse(processed) as string

  let result = DOMPurify.sanitize(html, {
    ADD_ATTR: ['class', 'id', 'data-src', 'data-highlighted', 'target', 'rel'],
    ADD_TAGS: ['math', 'mfrac', 'mrow', 'mi', 'mn', 'mo', 'msup', 'msub', 'msubsup', 'mover', 'munder', 'munderover', 'mtable', 'mtr', 'mtd', 'annotation', 'semantics'],
    ALLOW_DATA_ATTR: true,
  })

  // Fill KaTeX formulas
  if (options.enableMath !== false) {
    result = await fillFormulas(result, formulas)
  }

  return result
}

/**
 * Extract Table of Contents from Markdown
 */
export function extractToc(md: string): TocItem[] {
  const stripped = md.replace(/^---[\s\S]*?---\n*/m, '')
  const lines = stripped.split('\n')
  const toc: TocItem[] = []

  for (const line of lines) {
    const match = line.match(/^(#{1,3})\s+(.+)$/)
    if (match) {
      const level = match[1]!.length as 1 | 2 | 3
      const text = match[2]!.replace(/\*\*|__|~~|`/g, '').trim()
      const id = slugify(text)
      toc.push({ level, text, id })
    }
  }

  return toc
}

/**
 * Check if markdown contains mermaid diagrams
 */
export function hasMermaid(md: string): boolean {
  return /^```mermaid/m.test(md)
}

/**
 * Check if markdown contains math formulas
 */
export function hasMath(md: string): boolean {
  return /\$/.test(md)
}
