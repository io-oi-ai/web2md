#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createConnection } from 'node:net'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fetchViaExtension, resolveExtensionTarget, closeBridgeServer } from './bridge-client.js'
import { syncLibrary } from './vendor/sync'
import { fetchLibraryPage, makeFsSyncDeps, validateSyncDir } from './library.js'

const API_BASE = process.env.WEB2MD_API_URL || 'https://web2md.org/api'
/** Fallback: read apiKey from the CLI's ~/.web2md/config.json (written by `web2md login`). */
function readConfigApiKey(): string {
  try {
    const raw = readFileSync(join(homedir(), '.web2md', 'config.json'), 'utf-8')
    const cfg = JSON.parse(raw) as { apiKey?: unknown }
    return typeof cfg.apiKey === 'string' ? cfg.apiKey : ''
  } catch {
    return '' // missing/unreadable/invalid config — fall back to the warning below
  }
}

let API_KEY = process.env.WEB2MD_API_KEY || readConfigApiKey()

if (!API_KEY) {
  // OAuth 自动登录(2026-09-05):无凭证时不再只是报错等死 —— 启动即发起
  // 浏览器 OAuth(loopback+PKCE+品牌 consent 页),成功后热更新 key。
  // 体验对齐 `gh auth login`。可用 WEB2MD_OAUTH_AUTOLOGIN=0 关闭(CI 等场景)。
  if (process.env.WEB2MD_OAUTH_AUTOLOGIN !== '0') {
    console.error('No credentials found — starting browser sign-in (set WEB2MD_OAUTH_AUTOLOGIN=0 to disable)…')
    import('./oauth.js')
      .then(({ oauthLogin }) => oauthLogin())
      .then((key) => { API_KEY = key })
      .catch((e) => console.error('Sign-in failed:', e instanceof Error ? e.message : e, '\nRun: npx web2md-cli login'))
  } else {
    console.error('Warning: no API key found. Set WEB2MD_API_KEY, or run: npx web2md-cli login')
  }
}

// key 可能在启动后由 OAuth 流补上,所以用 getter 现取
const authHeaders = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${API_KEY}`,
})

/**
 * Read the real package version instead of hardcoding it — a stale serverInfo
 * misleads anyone debugging which build a client is actually talking to.
 */
function packageVersion(): string {
  // This bundle is emitted as CommonJS, so `import.meta.url` is unavailable —
  // resolve relative to the entry script instead. dist/index.js sits one level
  // below the package root, same as the source layout assumed here.
  try {
    const entry = process.argv[1]
    const base = entry ? dirname(entry) : __dirname
    const raw = readFileSync(join(base, '..', 'package.json'), 'utf-8')
    const pkg = JSON.parse(raw) as { version?: unknown; name?: unknown }
    // Guard against picking up an unrelated package.json if the layout shifts.
    // ⚠ Two package names ship this same server: `web2md-mcp-server` on npm and
    // `web2md-mcp` in the standalone open-source repo (io-oi-ai/web2md-mcp, the
    // one Glama indexes). Checking only the npm name made the mirrored build
    // report serverInfo 0.0.0 — which is exactly the stale-version confusion
    // this function exists to prevent.
    const KNOWN = ['web2md-mcp-server', 'web2md-mcp']
    if (typeof pkg.name === 'string' && KNOWN.includes(pkg.name) && typeof pkg.version === 'string') {
      return pkg.version
    }
  } catch {
    // fall through
  }
  return '0.0.0'
}

const server = new McpServer({
  name: 'web2md',
  version: packageVersion(),
})

server.tool(
  'convert_url',
  // 2026-11-05:Glama TDQS 两次给 Disambiguation / Naming Consistency 2/5,
  // 原话是 convert_url / bridge_convert_url / agent_convert 三者"重叠明显,
  // agent 很难知道该用哪个"。三条描述原本都写着 "Reddit / JS-rendered /
  // login-protected",只在传输方式上有别 —— 而传输方式是实现细节,不是选择依据。
  // 改法:每条开头先写**什么时候用**,再写代价和前置条件,让 agent 能按
  // "这个 URL 需不需要我的登录态" 一步判断。排序也构成一条决策链:
  //   convert_url(先试这个)→ 失败/需登录 → agent_convert(静默)
  //   → 没装 native host → bridge_convert_url(会弹标签页)
  'Convert a public webpage to clean Markdown. START HERE for any URL — it needs no browser, no extension, and no setup. Returns Markdown plus metadata (title, word count, reading time). If the page needs your login session or renders only after JavaScript runs (Reddit, X, paywalled articles, internal dashboards), this returns a login wall or an empty shell — switch to agent_convert in that case.',
  {
    url: z.string().url().describe('The URL of the webpage to convert'),
    includeImages: z.boolean().optional().describe('Include image references (default: true)'),
    includeLinks: z.boolean().optional().describe('Include hyperlinks (default: true)'),
  },
  async ({ url, includeImages, includeLinks }) => {
    const resp = await fetch(`${API_BASE}/v1/convert`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        url,
        options: { includeImages: includeImages ?? true, includeLinks: includeLinks ?? true },
      }),
    })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      return { content: [{ type: 'text' as const, text: `Error: ${err.error || resp.statusText}` }] }
    }

    const data = await resp.json()
    const md = data.data.markdown
    const meta = data.data.metadata

    return {
      content: [
        {
          type: 'text' as const,
          text: `# ${meta.title}\n\n**Source:** ${meta.url}\n**Words:** ${meta.wordCount} | **Reading time:** ${meta.readingTime} min\n\n---\n\n${md}`,
        },
      ],
    }
  }
)

// ── convert_file(2026-09-05):本地文件 → Markdown。
//    补齐 Agent 生态的能力缺口(convert_url 只吃 URL)。底层用 Firecrawl anydoc
//    的 napi 绑定(Rust,毫秒级,表格/列表/脚注保真)—— 本地 MCP 跑在用户机器
//    上,平台二进制天然可用。anydoc 是 optionalDependency,装不上时工具给出
//    可操作的提示而不是崩溃。PDF 需 anydoc 内建能力,扫描件它读不了(可后续
//    接 Firecrawl Parse OCR)。
server.tool(
  'convert_file',
  'Convert a local document file to clean Markdown. Supports Word (.docx/.doc), PowerPoint (.pptx/.ppt), Excel (.xlsx/.xls), OpenDocument (.odt/.ods/.odp), RTF, EPUB, CSV, and PDF. Tables, headings, lists and footnotes are preserved. Fast, fully local — the file never leaves the machine.',
  {
    path: z.string().describe('Absolute path to the document file on the local filesystem'),
  },
  async ({ path: filePath }) => {
    const err = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
    let anydoc: { toMarkdown: (path: string) => Promise<string> }
    try {
      anydoc = await import('@firecrawl/anydoc')
    } catch {
      return err(
        'The document converter is not installed on this machine. Install it with:\n  npm i -g @firecrawl/anydoc\nthen retry. (It ships prebuilt binaries for macOS/Linux/Windows.)'
      )
    }
    const nodePath = await import('node:path')
    const { existsSync } = await import('node:fs')
    if (!existsSync(filePath)) {
      return err(`File not found: ${filePath}. Use an absolute path to an existing file.`)
    }
    const ext = nodePath.extname(filePath).slice(1).toLowerCase()
    try {
      const md = await anydoc.toMarkdown(filePath)
      const name = nodePath.basename(filePath)
      return {
        content: [
          {
            type: 'text' as const,
            text: `# ${name}\n\n**Source:** ${filePath}\n**Type:** ${ext.toUpperCase()}\n\n---\n\n${md}`,
          },
        ],
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return err(`Conversion failed for ${filePath}: ${msg}. Scanned PDFs need OCR (not yet supported locally).`)
    }
  }
)

server.tool(
  'semantic_search',
  '[deprecated: use search_library/get_library_items] Search your saved conversions using natural language. Works across languages.',
  {
    query: z.string().describe('Natural language search query'),
    limit: z.number().optional().describe('Max results (default: 5)'),
  },
  async ({ query, limit }) => {
    const params = new URLSearchParams({ q: query, limit: String(limit || 5) })
    const resp = await fetch(`${API_BASE}/search?${params}`, { headers: authHeaders() })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      return { content: [{ type: 'text' as const, text: `Error: ${err.error || resp.statusText}` }] }
    }

    const data = await resp.json()
    if (!data.results || data.results.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No results found.' }] }
    }

    const text = data.results
      .map((r: any, i: number) => `${i + 1}. **${r.title}** (${r.url})\n   ${r.summary || ''}`)
      .join('\n\n')

    return { content: [{ type: 'text' as const, text }] }
  }
)

server.tool(
  'get_conversion',
  '[deprecated: use search_library/get_library_items] Retrieve the full Markdown content of a previously saved conversion by its ID.',
  {
    id: z.string().describe('The conversion ID'),
  },
  async ({ id }) => {
    const resp = await fetch(`${API_BASE}/history/${id}`, { headers: authHeaders() })

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }))
      return { content: [{ type: 'text' as const, text: `Error: ${err.error || resp.statusText}` }] }
    }

    const data = await resp.json()
    return {
      content: [
        {
          type: 'text' as const,
          text: `# ${data.title}\n\n**URL:** ${data.url}\n\n---\n\n${data.markdown}`,
        },
      ],
    }
  }
)

server.tool(
  'bridge_convert_url',
  'FALLBACK for agent_convert when the native host is not installed. Same capability — reads the page through the user\'s signed-in Chrome — but it works by opening a browser tab, so it is visible and takes focus. Prefer agent_convert whenever the native host is available; use this one if agent_convert reports the host is missing, or on a machine where you cannot install it. Needs only the Web2MD extension installed and signed in; the extension is found automatically via the API key.',
  {
    url: z.string().url().describe('The URL to convert (Reddit, paywalled, JS-rendered, etc.)'),
    extensionId: z.string().optional().describe('Override extension ID (auto-discovered if omitted)'),
  },
  async ({ url, extensionId: overrideId }) => {
    try {
      const target = overrideId
        ? { extensionId: overrideId, browser: null }
        : await resolveExtensionTarget(API_BASE, API_KEY)
      const { html } = await fetchViaExtension(url, target.extensionId, target.browser)

      // Convert HTML → Markdown via the API (reuse server-side converter)
      const resp = await fetch(`${API_BASE}/v1/convert`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ html, url, options: { includeImages: true, includeLinks: true } }),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }))
        return { content: [{ type: 'text' as const, text: `Conversion failed: ${err.error || resp.statusText}` }] }
      }

      const data = await resp.json()
      const md = data.data.markdown
      const meta = data.data.metadata

      return {
        content: [
          {
            type: 'text' as const,
            text: `# ${meta.title}\n\n**Source:** ${meta.url}\n**Words:** ${meta.wordCount} | **Reading time:** ${meta.readingTime} min\n\n---\n\n${md}`,
          },
        ],
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `Bridge error: ${msg}` }] }
    } finally {
      closeBridgeServer()
    }
  }
)

// ── Agent Bridge via Native Messaging ────────────────────────

const AGENT_TCP_PORT = 12315
const AGENT_TIMEOUT = 30000

interface AgentResponse {
  id: string
  type: string
  url?: string
  title?: string
  markdown?: string
  error?: string
  index?: number
  total?: number
}

function agentRequest(msg: { id: string; type: string; [k: string]: unknown }): Promise<AgentResponse[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port: AGENT_TCP_PORT, host: '127.0.0.1' })
    const results: AgentResponse[] = []
    let lineBuf = ''
    let done = false

    const urls = Array.isArray(msg.urls) ? msg.urls as string[] : []
    const timeout = setTimeout(() => {
      if (!done) {
        done = true
        socket.destroy()
        reject(new Error('Agent request timed out'))
      }
    }, AGENT_TIMEOUT * Math.max(urls.length, 1))

    socket.on('connect', () => {
      socket.write(JSON.stringify(msg) + '\n')
    })

    socket.on('data', (chunk) => {
      lineBuf += chunk.toString()
      let nl: number
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        const line = lineBuf.slice(0, nl).trim()
        lineBuf = lineBuf.slice(nl + 1)
        if (!line) continue
        try {
          const resp = JSON.parse(line) as AgentResponse
          results.push(resp)
          if (resp.type === 'convert_result' || resp.type === 'error' || resp.type === 'pong' || resp.type === 'batch_complete') {
            done = true
            clearTimeout(timeout)
            socket.end()
            resolve(results)
          }
        } catch { /* skip */ }
      }
    })

    socket.on('error', (err) => {
      if (!done) {
        done = true
        clearTimeout(timeout)
        reject(new Error(`Agent connection error: ${err.message}. Ensure Chrome is open with Web2MD extension and native host installed.`))
      }
    })

    socket.on('close', () => {
      if (!done) {
        done = true
        clearTimeout(timeout)
        resolve(results)
      }
    })
  })
}

server.tool(
  'agent_convert',
  'Convert one URL through the user\'s own signed-in Chrome, reading the page exactly as they see it. USE THIS when convert_url hits a login wall or returns an empty shell — Reddit, X, paywalled articles, internal wikis, dashboards. Runs silently in the background over a local connection; it does not open or steal focus from any tab. Requires Chrome running with the Web2MD extension and the native host installed (npx -p web2md-mcp-server web2md-mcp-setup). For several URLs at once use agent_batch_convert; if the native host is not installed use bridge_convert_url.',
  {
    url: z.string().url().describe('The URL to convert'),
    skill: z.string().optional().describe('Skill name or id to apply — its body is returned alongside the markdown for you to follow'),
  },
  async ({ url, skill }) => {
    try {
      const id = `mcp_${Date.now()}`
      const results = await agentRequest({ id, type: 'agent_convert', url })
      const result = results.find(r => r.type === 'convert_result')
      const error = results.find(r => r.type === 'error')

      if (error) {
        return { content: [{ type: 'text' as const, text: `Error: ${error.error}` }] }
      }
      if (result?.markdown) {
        let text = `# ${result.title || 'Untitled'}\n\n**Source:** ${url}\n\n---\n\n${result.markdown}`
        if (skill) {
          try {
            const skills = await fetchSkills()
            const match = skills.find((s) => s.id === skill || s.name === skill)
            text += match
              ? `\n\n---\n## Apply this skill:\n${match.body}`
              : `\n\n---\n_Note: skill "${skill}" not found; returning markdown only._`
          } catch (skillErr) {
            const msg = skillErr instanceof Error ? skillErr.message : String(skillErr)
            text += `\n\n---\n_Note: could not load skill "${skill}" (${msg}); returning markdown only._`
          }
        }
        return {
          content: [{
            type: 'text' as const,
            text,
          }],
        }
      }
      return { content: [{ type: 'text' as const, text: 'No result returned from extension' }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Agent error: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

server.tool(
  'agent_batch_convert',
  'The multi-URL form of agent_convert: up to 50 URLs in one call, each read through the user\'s signed-in Chrome. USE THIS instead of calling agent_convert in a loop — one call, one round trip, and each result carries its own token count. URLs are processed one after another, so a long list takes a while. Same requirements as agent_convert (Chrome + extension + native host).',
  {
    urls: z.array(z.string().url()).min(1).max(50).describe('Array of URLs to convert (max 50)'),
  },
  async ({ urls }) => {
    try {
      const id = `mcp_batch_${Date.now()}`
      const results = await agentRequest({ id, type: 'agent_batch_convert', urls })

      const items = results.filter(r => r.type === 'batch_item_result')
      const parts: string[] = []

      for (const item of items) {
        if (item.error) {
          parts.push(`## Error: ${item.url}\n\nError: ${item.error}\n`)
        } else {
          parts.push(`## ${item.title || item.url}\n\n**Source:** ${item.url}\n\n---\n\n${item.markdown}\n`)
        }
      }

      const summary = `Converted ${items.filter(i => !i.error).length}/${urls.length} URLs successfully.\n\n`
      return { content: [{ type: 'text' as const, text: summary + parts.join('\n---\n\n') }] }
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Agent error: ${err instanceof Error ? err.message : String(err)}` }] }
    }
  }
)

// ── Skills ────────────────────────────────────────────────────

interface Skill {
  id: string
  name: string
  description: string
  body: string
  source?: string
  createdAt?: string
}

async function fetchSkills(): Promise<Skill[]> {
  if (!API_KEY) throw new Error('WEB2MD_API_KEY is not set')
  const resp = await fetch(`${API_BASE}/skills`, { headers: authHeaders() })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }))
    throw new Error(err.error || `API error ${resp.status}`)
  }
  const data = await resp.json()
  return Array.isArray(data?.skills) ? (data.skills as Skill[]) : []
}

server.tool(
  'list_skills',
  'List the skills saved in your Web2MD cloud account. Returns a compact list (id, name, description). Use get_skill to fetch the full SKILL.md body of one.',
  {},
  async () => {
    try {
      const skills = await fetchSkills()
      const rows = skills.map((s) => ({ id: s.id, name: s.name, description: s.description }))
      return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] }
    } catch (err) {
      return libraryError(err)
    }
  }
)

server.tool(
  'get_skill',
  'Fetch the full content of a single Web2MD skill by id (or name). Returns its name, description, and complete SKILL.md body. Use list_skills first to find ids.',
  {
    id: z.string().describe('Skill id (or name) to fetch'),
  },
  async ({ id }) => {
    try {
      const skills = await fetchSkills()
      const skill = skills.find((s) => s.id === id || s.name === id)
      if (!skill) {
        return argumentError(`Skill not found: ${id}`)
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `# ${skill.name}\n\n${skill.description || ''}\n\n---\n\n${skill.body}`,
          },
        ],
      }
    } catch (err) {
      return libraryError(err)
    }
  }
)

// ── Library tools ─────────────────────────────────────────────

function libraryError(err: unknown): { content: { type: 'text'; text: string }[] } {
  const message = err instanceof Error ? err.message : String(err)
  const hint = !API_KEY
    ? 'Set the WEB2MD_API_KEY environment variable, or run `npx web2md-cli login` (get a key at https://web2md.org/dashboard).'
    : /API error 401|invalid or revoked api key/i.test(message)
      ? 'Check that WEB2MD_API_KEY is a valid w2m_ key, or re-run `npx web2md-cli login` if the key came from ~/.web2md/config.json.'
      : 'Retry, or check network access to web2md.org.'
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message, hint }) }] }
}

function argumentError(error: string): { content: { type: 'text'; text: string }[] } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error, hint: 'fix the argument' }) }],
  }
}

server.tool(
  'search_library',
  'Search your Web2MD library (saved conversions) by keyword (matches title and full page content) and/or tag, newest first. Returns item metadata: id, title, url, date, tags. Use get_library_items to fetch full markdown.',
  {
    query: z.string().optional().describe('Keyword search over title and full page content'),
    tag: z.string().optional().describe('Filter by tag'),
    since: z.string().optional().describe('Only items created on/after this ISO date (YYYY-MM-DD)'),
    limit: z.number().optional().describe('Max results (default 20, max 100)'),
  },
  async ({ query, tag, since, limit }) => {
    try {
      if (!API_KEY) throw new Error('WEB2MD_API_KEY is not set')
      const sinceTs = since ? Date.parse(since) : undefined
      if (sinceTs !== undefined && Number.isNaN(sinceTs)) {
        return argumentError(`Invalid since date: ${since}`)
      }
      const capped = Math.min(Math.max(limit ?? 20, 1), 100)
      const page = await fetchLibraryPage(
        { apiBase: API_BASE, apiKey: API_KEY },
        { fields: 'meta', q: query, tag, limit: capped, order: 'desc' }
      )
      let items = page.items
      if (sinceTs !== undefined) {
        items = items.filter((it) => Date.parse(it.createdAt) >= sinceTs)
      }
      const rows = items.map((it) => ({
        id: it.id,
        title: it.title,
        url: it.url,
        date: it.createdAt.slice(0, 10),
        tags: it.tags,
      }))
      let text = JSON.stringify(rows, null, 2)
      if (page.truncated) {
        text += '\n\nNote: free plan only shows the most recent items — upgrade for full history (https://web2md.org/pricing).'
      }
      return { content: [{ type: 'text' as const, text }] }
    } catch (err) {
      return libraryError(err)
    }
  }
)

server.tool(
  'get_library_items',
  'Fetch full markdown content for library items by id (max 20 per call). Use search_library first to find ids. Responses can be very large — for long pages, batch 5 or fewer ids per call.',
  {
    ids: z.array(z.string()).min(1).describe('Item ids to fetch (max 20)'),
  },
  async ({ ids }) => {
    try {
      if (!API_KEY) throw new Error('WEB2MD_API_KEY is not set')
      if (ids.length > 20) {
        return argumentError(`Too many ids: ${ids.length} (max 20)`)
      }
      const page = await fetchLibraryPage({ apiBase: API_BASE, apiKey: API_KEY }, { ids })
      const found = new Set(page.items.map((it) => it.id))
      const results: unknown[] = page.items.map((it) =>
        it.markdown !== undefined
          ? { id: it.id, title: it.title, url: it.url, markdown: it.markdown }
          : { id: it.id, title: it.title, url: it.url, skipped: 'no markdown (oversize or content unavailable)' }
      )
      for (const id of ids) {
        if (!found.has(id)) results.push({ id, skipped: 'not found' })
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] }
    } catch (err) {
      return libraryError(err)
    }
  }
)

server.tool(
  'sync_library',
  'Sync your Web2MD library to a local directory as markdown files (organized by tag, with frontmatter). Incremental by default; keeps state in <dir>/.web2md-sync.json.',
  {
    dir: z.string().describe('Absolute path of the target directory'),
    tag: z.string().optional().describe('Only sync items with this tag'),
    full: z.boolean().optional().describe('Ignore incremental cursor and re-scan full history'),
  },
  async ({ dir, tag, full }) => {
    try {
      if (!API_KEY) throw new Error('WEB2MD_API_KEY is not set')
      let target: string
      try {
        target = validateSyncDir(dir)
      } catch (err) {
        return argumentError(err instanceof Error ? err.message : String(err))
      }
      const deps = makeFsSyncDeps(target, { apiBase: API_BASE, apiKey: API_KEY })
      const result = await syncLibrary(deps, { tag, full })
      const stats: Record<string, unknown> = {
        added: result.added,
        skipped: result.skipped,
        failed: result.failed,
        truncated: result.truncated,
        dir: target,
      }
      if (result.failed > 0) stats.errors = result.errors
      return { content: [{ type: 'text' as const, text: JSON.stringify(stats, null, 2) }] }
    } catch (err) {
      return libraryError(err)
    }
  }
)

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch(console.error)
