/**
 * 简化的 Token 计算器
 * 基于字符数和词数的启发式估算
 *
 * GPT/Claude 的 Tokenizer 实际上更复杂，
 * 这里提供一个足够准确的估算值
 */

// 不同模型的 Token 估算系数
const TOKEN_RATIOS = {
  // GPT-4/GPT-3.5 (cl100k_base)
  gpt: {
    english: 4, // 平均每 4 个字符 = 1 token
    chinese: 1.5, // 平均每 1.5 个中文字符 = 1 token
    code: 3, // 代码平均每 3 个字符 = 1 token
  },
  // Claude (claude tokenizer)
  claude: {
    english: 4,
    chinese: 1.2,
    code: 3,
  },
}

export interface TokenCount {
  /** 预估 Token 数 */
  tokens: number
  /** 字符数 */
  characters: number
  /** 词数（英文）/ 字数（中文） */
  words: number
  /** 预估阅读时间（分钟） */
  readingTime: number
}

/**
 * 计算文本的 Token 数
 */
export function countTokens(
  text: string,
  model: 'gpt' | 'claude' = 'claude'
): TokenCount {
  const characters = text.length
  const ratio = TOKEN_RATIOS[model]

  // 统计中文字符数
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
  // 统计代码块
  const codeBlocks = text.match(/```[\s\S]*?```/g) || []
  const codeChars = codeBlocks.join('').length
  // 英文字符数
  const englishChars = characters - chineseChars - codeChars

  // 计算 Token
  const tokens = Math.ceil(
    englishChars / ratio.english +
      chineseChars / ratio.chinese +
      codeChars / ratio.code
  )

  // 计算词数
  // 英文按空格分词，中文按字符计数
  const englishWords = text
    .replace(/[\u4e00-\u9fff]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0).length
  const words = englishWords + chineseChars

  // 阅读时间（假设每分钟 200 词/字）
  const readingTime = Math.ceil(words / 200)

  return {
    tokens,
    characters,
    words,
    readingTime: Math.max(1, readingTime),
  }
}

/**
 * 智能分段
 * 将长文本分成多个部分，每部分不超过指定 Token 数
 */
export function splitByTokens(
  text: string,
  maxTokens: number,
  model: 'gpt' | 'claude' = 'claude'
): string[] {
  const { tokens } = countTokens(text, model)

  // 如果不超限，直接返回
  if (tokens <= maxTokens) {
    return [text]
  }

  // 按段落分割
  const paragraphs = text.split(/\n\n+/)
  const chunks: string[] = []
  let currentChunk = ''

  for (const paragraph of paragraphs) {
    const testChunk = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph
    const { tokens: testTokens } = countTokens(testChunk, model)

    if (testTokens > maxTokens && currentChunk) {
      // 当前块已满，保存并开始新块
      chunks.push(currentChunk)
      currentChunk = paragraph
    } else {
      currentChunk = testChunk
    }
  }

  // 保存最后一块
  if (currentChunk) {
    chunks.push(currentChunk)
  }

  return chunks
}

/**
 * 获取常见模型的上下文限制
 */
export const MODEL_CONTEXT_LIMITS = {
  'gpt-3.5-turbo': 16385,
  'gpt-4': 8192,
  'gpt-4-turbo': 128000,
  'gpt-4o': 128000,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  'claude-3.5-sonnet': 200000,
  'claude-4-sonnet': 200000,
  'claude-4-opus': 200000,
  'gemini-1.5-pro': 1000000,
  'gemini-2.0-flash': 1000000,
} as const

export type ModelName = keyof typeof MODEL_CONTEXT_LIMITS

/** Target AI model presets for context window optimization */
export type TargetAIModel = 'claude-200k' | 'gpt-128k' | 'gemini-1m'

const TARGET_MODEL_LIMITS: Record<TargetAIModel, number> = {
  'claude-200k': 180000,  // Leave 20K headroom for system prompt + response
  'gpt-128k': 110000,     // Leave 18K headroom
  'gemini-1m': 900000,    // Leave 100K headroom
}

/**
 * Smart content compression for target AI model context window.
 *
 * Strategy:
 * - Preserves: code blocks, headings, first/last paragraphs
 * - Removes: duplicate whitespace, repeated separators
 * - Truncates: middle sections when content exceeds limit
 * - Respects: semantic boundaries (paragraph/section breaks)
 */
export function optimizeForContextWindow(
  markdown: string,
  targetModel: TargetAIModel = 'claude-200k',
  model: 'gpt' | 'claude' = 'claude'
): { markdown: string; truncated: boolean; originalTokens: number; optimizedTokens: number } {
  const maxTokens = TARGET_MODEL_LIMITS[targetModel]
  const originalCount = countTokens(markdown, model)

  if (originalCount.tokens <= maxTokens) {
    return {
      markdown,
      truncated: false,
      originalTokens: originalCount.tokens,
      optimizedTokens: originalCount.tokens,
    }
  }

  // Step 1: Clean up redundant whitespace
  let optimized = markdown
    .replace(/\n{4,}/g, '\n\n\n')           // Max 3 consecutive newlines
    .replace(/^[ \t]+$/gm, '')               // Remove whitespace-only lines
    .replace(/(---\n){2,}/g, '---\n')        // Dedupe horizontal rules

  let currentTokens = countTokens(optimized, model).tokens
  if (currentTokens <= maxTokens) {
    return {
      markdown: optimized,
      truncated: false,
      originalTokens: originalCount.tokens,
      optimizedTokens: currentTokens,
    }
  }

  // Step 2: Split into sections and apply smart truncation
  const sections = splitIntoSections(optimized)

  // Identify protected sections (code blocks, headings, first/last)
  const protectedIndices = new Set<number>()
  protectedIndices.add(0)                           // First section
  protectedIndices.add(sections.length - 1)         // Last section

  sections.forEach((section, i) => {
    if (section.startsWith('```') || section.startsWith('#')) {
      protectedIndices.add(i)
    }
  })

  // Calculate tokens for protected sections
  let protectedTokens = 0
  protectedIndices.forEach(i => {
    const section = sections[i]
    if (section) protectedTokens += countTokens(section, model).tokens
  })

  // Budget for unprotected sections
  const remainingBudget = maxTokens - protectedTokens - 100 // 100 token safety margin
  const unprotectedSections = sections
    .map((s, i) => ({ content: s, index: i }))
    .filter(s => !protectedIndices.has(s.index))

  if (remainingBudget <= 0 || unprotectedSections.length === 0) {
    // Only keep protected sections
    const kept = sections.filter((_, i) => protectedIndices.has(i))
    const result = kept.join('\n\n') + '\n\n> [Content truncated to fit context window]'
    return {
      markdown: result,
      truncated: true,
      originalTokens: originalCount.tokens,
      optimizedTokens: countTokens(result, model).tokens,
    }
  }

  // Distribute budget evenly among unprotected sections
  const budgetPerSection = Math.floor(remainingBudget / unprotectedSections.length)

  const finalSections: string[] = []
  let truncated = false

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]
    if (!section) continue
    if (protectedIndices.has(i)) {
      finalSections.push(section)
    } else {
      const sectionTokens = countTokens(section, model).tokens
      if (sectionTokens <= budgetPerSection) {
        finalSections.push(section)
      } else {
        // Truncate this section
        truncated = true
        const truncatedSection = truncateToTokens(section, budgetPerSection, model)
        finalSections.push(truncatedSection)
      }
    }
  }

  const result = finalSections.join('\n\n')
  const finalNote = truncated ? '\n\n> [Content optimized to fit context window]' : ''

  return {
    markdown: result + finalNote,
    truncated,
    originalTokens: originalCount.tokens,
    optimizedTokens: countTokens(result + finalNote, model).tokens,
  }
}

/** Split markdown into logical sections (by headings or double newlines) */
function splitIntoSections(markdown: string): string[] {
  // Split by headings or triple+ newlines
  const parts = markdown.split(/(?=^#{1,6}\s)/m)
  return parts.filter(p => p.trim().length > 0)
}

/** Truncate text to approximately maxTokens */
function truncateToTokens(text: string, maxTokens: number, model: 'gpt' | 'claude'): string {
  const paragraphs = text.split(/\n\n+/)
  let result = ''

  for (const para of paragraphs) {
    const test = result ? result + '\n\n' + para : para
    if (countTokens(test, model).tokens > maxTokens) {
      break
    }
    result = test
  }

  return result || text.slice(0, maxTokens * 3) // Fallback: rough character estimate
}
