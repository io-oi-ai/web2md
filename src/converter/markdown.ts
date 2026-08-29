import TurndownService from 'turndown'
import { parseHTML } from 'linkedom'
import { normalizeHeadings, cleanCodeBlocks, expandTabPanels } from './extractor'
import type { ConvertOptions } from '../types'

/**
 * 从 CDN 代理 URL 中提取原始图片 URL
 * 覆盖 substackcdn、images.weserv.nl、imageproxy 等 CDN 代理
 */
function cleanImageUrl(url: string): string {
  // 通用 CDN 代理 URL 还原：匹配 /image/fetch/<params>/<encoded_or_raw_url> 模式
  const cdnProxyMatch = url.match(
    /https?:\/\/[^/]+\/image\/fetch\/[^/]+\/(.+)/
  )
  if (cdnProxyMatch && cdnProxyMatch[1]) {
    try { url = decodeURIComponent(cdnProxyMatch[1]) } catch {}
  }

  // 移除常见 CDN 签名参数（如 $s_!hash!）
  url = url.replace(/\$s_![^!]*!/g, '')

  return url
}

/**
 * 编码图片 URL 中破坏 Markdown 语法的字符
 */
function encodeImageUrl(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29')
}

// 创建 Turndown 实例
function createTurndown(options: ConvertOptions = {}): TurndownService {
  const turndown = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    linkReferenceStyle: 'full',
  })

  // 处理图片
  if (!options.includeImages) {
    turndown.addRule('removeImages', {
      filter: 'img',
      replacement: () => '',
    })
  } else {
    // 保留图片，优化格式
    turndown.addRule('images', {
      filter: 'img',
      replacement: (_content, node) => {
        const img = node as HTMLImageElement
        const alt = img.alt || ''

        // 过滤装饰性小图片（<33px 的图标、头像等）
        const width = parseInt(img.getAttribute('width') || '0', 10)
        const height = parseInt(img.getAttribute('height') || '0', 10)
        const styleWidth = parseInt((img.getAttribute('style') || '').match(/width:\s*(\d+)/)?.[1] || '0', 10)
        const styleHeight = parseInt((img.getAttribute('style') || '').match(/height:\s*(\d+)/)?.[1] || '0', 10)
        const w = width || styleWidth
        const h = height || styleHeight
        if ((w > 0 && w < 33) || (h > 0 && h < 33)) return ''

        // 通用优先级：data-attrs JSON > data-orig-file > data-src > data-lazy-src > src
        let src = ''
        // 1. 尝试从 data-attrs JSON 中提取（CMS 常用模式）
        const dataAttrs = img.getAttribute('data-attrs')
        if (dataAttrs) {
          try {
            const attrs = JSON.parse(dataAttrs)
            if (attrs.src) src = attrs.src
          } catch {}
        }
        // 2. 常见 data 属性回退
        if (!src) src = img.getAttribute('data-orig-file')
            || img.getAttribute('data-src')
            || img.getAttribute('data-lazy-src')
            || img.src || ''

        src = cleanImageUrl(src)
        src = encodeImageUrl(src)
        const title = img.title ? ` "${img.title}"` : ''
        return src ? `![${alt}](${src}${title})` : ''
      },
    })
  }

  // 处理链接
  if (!options.includeLinks) {
    turndown.addRule('removeLinks', {
      filter: 'a',
      replacement: (content) => content,
    })
  }

  // 清理 CDN 代理链接 href
  turndown.addRule('cleanCdnLinks', {
    filter: (node) => {
      return node.nodeName === 'A' &&
        /\/image\/fetch\//.test((node as HTMLAnchorElement).getAttribute('href') || '')
    },
    replacement: (content, node) => {
      const a = node as HTMLAnchorElement
      let href = cleanImageUrl(a.getAttribute('href') || '')
      href = encodeImageUrl(href)
      return content ? `[${content}](${href})` : ''
    },
  })

  // 处理代码块
  turndown.addRule('codeBlocks', {
    filter: (node) => {
      return (
        node.nodeName === 'PRE' &&
        node.firstChild !== null &&
        node.firstChild.nodeName === 'CODE'
      )
    },
    replacement: (content, node) => {
      const codeNode = node.firstChild as HTMLElement
      let language = ''

      // 尝试从 class 获取语言
      const className = codeNode.className || ''
      const langMatch = className.match(/(?:language-|lang-)(\w+)/)
      if (langMatch && langMatch[1]) {
        language = langMatch[1]
      }

      // 检测语言（如果启用）
      if (!language && options.detectCodeLanguage) {
        language = detectCodeLanguage(codeNode.textContent || '')
      }

      const code = codeNode.textContent || ''
      return `\n\`\`\`${language}\n${code}\n\`\`\`\n`
    },
  })

  // 处理内联代码
  turndown.addRule('inlineCode', {
    filter: (node) => {
      return node.nodeName === 'CODE' && node.parentNode?.nodeName !== 'PRE'
    },
    replacement: (content) => {
      if (!content) return ''
      // 如果内容包含反引号，使用双反引号
      if (content.includes('`')) {
        return `\`\` ${content} \`\``
      }
      return `\`${content}\``
    },
  })

  // 处理表格
  turndown.addRule('tables', {
    filter: 'table',
    replacement: (content, node) => {
      const table = node as HTMLTableElement
      return convertTableToMarkdown(table)
    },
  })

  // 处理任务列表 checkbox
  turndown.addRule('taskListItems', {
    filter: (node) => {
      return (
        node.nodeName === 'LI' &&
        node.firstChild !== null &&
        node.firstChild.nodeName === 'INPUT' &&
        (node.firstChild as HTMLInputElement).type === 'checkbox'
      )
    },
    replacement: (content, node) => {
      const li = node as HTMLLIElement
      const checkbox = li.firstChild as HTMLInputElement
      const checked = checkbox.checked ? 'x' : ' '
      // 移除 content 开头由 checkbox input 产生的空白
      const text = content.replace(/^\s*/, '').trimEnd()
      return `- [${checked}] ${text}\n`
    },
  })

  // 处理行内 LaTeX 公式（span.math-inline / span.math）
  turndown.addRule('mathInline', {
    filter: (node) => {
      if (node.nodeName !== 'SPAN') return false
      const cls = (node as HTMLElement).className || ''
      return /\bmath-inline\b|\bmath\b/.test(cls)
    },
    replacement: (_content, node) => {
      const text = (node as HTMLElement).textContent || ''
      return `$${text}$`
    },
  })

  // 处理块级 LaTeX 公式（div.math-display / div.math）
  turndown.addRule('mathBlock', {
    filter: (node) => {
      if (node.nodeName !== 'DIV') return false
      const cls = (node as HTMLElement).className || ''
      return /\bmath-display\b|\bmath\b/.test(cls)
    },
    replacement: (_content, node) => {
      const text = (node as HTMLElement).textContent || ''
      return `\n$$\n${text.trim()}\n$$\n`
    },
  })

  // 处理 MathJax script 标签（行内和块级）
  turndown.addRule('mathJaxScript', {
    filter: (node) => {
      if (node.nodeName !== 'SCRIPT') return false
      const type = (node as HTMLElement).getAttribute('type') || ''
      return type.startsWith('math/tex')
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement
      const type = el.getAttribute('type') || ''
      const text = el.textContent || ''
      if (type.includes('mode=display')) {
        return `\n$$\n${text.trim()}\n$$\n`
      }
      return `$${text.trim()}$`
    },
  })

  // 处理脚注引用（上标中的链接 <sup><a href="#fn:N">）
  turndown.addRule('footnoteRef', {
    filter: (node) => {
      if (node.nodeName !== 'SUP') return false
      const a = node.firstChild
      if (!a || a.nodeName !== 'A') return false
      const href = (a as HTMLAnchorElement).getAttribute('href') || ''
      return /^#fn[:\-_]?\d+/.test(href)
    },
    replacement: (_content, node) => {
      const a = node.firstChild as HTMLAnchorElement
      const href = a.getAttribute('href') || ''
      const match = href.match(/(\d+)$/)
      const num = match ? match[1] : (a.textContent || '').trim()
      return `[^${num}]`
    },
  })

  // 处理脚注定义列表（.footnotes ol li）
  turndown.addRule('footnoteItem', {
    filter: (node) => {
      if (node.nodeName !== 'LI') return false
      const id = (node as HTMLElement).id || ''
      return /^fn[:\-_]?\d+/.test(id)
    },
    replacement: (content, node) => {
      const id = (node as HTMLElement).id || ''
      const match = id.match(/(\d+)$/)
      const num = match ? match[1] : ''
      // 移除回链锚点（通常是 ↩ 字符或 .footnote-backref）
      const text = content.replace(/\s*\[↩\]\([^)]*\)/g, '').replace(/\s*↩\s*$/, '').trim()
      return `[^${num}]: ${text}\n`
    },
  })

  // 处理 .mermaid div（非代码块形式的 Mermaid 图表）
  turndown.addRule('mermaidDiv', {
    filter: (node) => {
      if (node.nodeName !== 'DIV') return false
      const cls = (node as HTMLElement).className || ''
      return /\bmermaid\b/.test(cls)
    },
    replacement: (_content, node) => {
      const text = (node as HTMLElement).textContent || ''
      return `\n\`\`\`mermaid\n${text.trim()}\n\`\`\`\n`
    },
  })

  // 移除空段落
  turndown.addRule('removeEmptyParagraphs', {
    filter: (node) => {
      return node.nodeName === 'P' && node.textContent?.trim() === ''
    },
    replacement: () => '',
  })

  return turndown
}

/**
 * 将 HTML 转换为 Markdown
 */
export function htmlToMarkdown(html: string, options: ConvertOptions = {}): string {
  // DOM 预处理：规范化假标题、清除代码块污染、展开 tab panels
  let processedHtml = html
  try {
    const { document: doc } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`)
    normalizeHeadings(doc)
    cleanCodeBlocks(doc)
    expandTabPanels(doc)
    processedHtml = doc.body.innerHTML
  } catch {
    // 解析失败时降级使用原始 HTML
  }

  const turndown = createTurndown(options)
  let markdown = turndown.turndown(processedHtml)

  // 后处理
  markdown = postProcess(markdown)

  return markdown
}

/**
 * 转换表格为 Markdown
 */
function convertTableToMarkdown(table: HTMLTableElement): string {
  const rows: string[][] = []

  // 获取所有行
  const tableRows = Array.from(table.querySelectorAll('tr'))
  for (const tr of tableRows) {
    const cells: string[] = []
    for (const cell of Array.from(tr.querySelectorAll('th, td'))) {
      cells.push(cell.textContent?.trim().replace(/\|/g, '\\|') || '')
    }
    if (cells.length > 0) {
      rows.push(cells)
    }
  }

  if (rows.length === 0) return ''

  // 确定列数
  const colCount = Math.max(...rows.map((r) => r.length))

  // 生成 Markdown 表格
  const lines: string[] = []

  // 表头
  const header = rows[0] || []
  const paddedHeader = [...header, ...Array(colCount - header.length).fill('')]
  lines.push(`| ${paddedHeader.join(' | ')} |`)

  // 分隔行
  lines.push(`| ${Array(colCount).fill('---').join(' | ')} |`)

  // 数据行
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || []
    const paddedRow = [...row, ...Array(colCount - row.length).fill('')]
    lines.push(`| ${paddedRow.join(' | ')} |`)
  }

  return '\n' + lines.join('\n') + '\n'
}

/**
 * 后处理 Markdown
 */
function postProcess(markdown: string): string {
  return (
    markdown
      // 移除多余空行
      .replace(/\n{3,}/g, '\n\n')
      // 修复列表格式
      .replace(/^(\s*[-*+])\s+/gm, '$1 ')
      // 移除行尾空格
      .replace(/[ \t]+$/gm, '')
      // 确保文件以单个换行结尾
      .trim() + '\n'
  )
}

/**
 * 简单的代码语言检测
 */
function detectCodeLanguage(code: string): string {
  const patterns: Array<{ lang: string; pattern: RegExp }> = [
    { lang: 'javascript', pattern: /\b(const|let|var|function|=>|async|await)\b/ },
    { lang: 'typescript', pattern: /\b(interface|type|enum|namespace)\b.*[:{]/ },
    { lang: 'python', pattern: /\b(def|import|from|class)\b.*:/ },
    { lang: 'java', pattern: /\b(public|private|protected)\s+(class|void|static)/ },
    { lang: 'go', pattern: /\b(func|package|import)\b/ },
    { lang: 'rust', pattern: /\b(fn|let|mut|impl|struct|enum)\b/ },
    { lang: 'html', pattern: /<\/?[a-z][\s\S]*>/i },
    { lang: 'css', pattern: /[.#][\w-]+\s*\{[\s\S]*\}/ },
    { lang: 'sql', pattern: /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/i },
    { lang: 'json', pattern: /^\s*[{\[][\s\S]*[}\]]\s*$/ },
    { lang: 'yaml', pattern: /^[\w-]+:\s/m },
    { lang: 'bash', pattern: /^\s*(#!\/bin\/|apt|npm|pip|brew|curl|wget)/m },
  ]

  for (const { lang, pattern } of patterns) {
    if (pattern.test(code)) {
      return lang
    }
  }

  return ''
}
