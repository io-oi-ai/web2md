/**
 * OAuth 登录(本地 MCP/CLI 通用,2026-09-05)。
 *
 * 体验对齐 `gh auth login` / claude.ai connector:
 *   1. DCR 自注册公共客户端(client_id 缓存 ~/.web2md/oauth-client.json,复用)
 *   2. 开浏览器 → /api/auth/mcp/authorize(PKCE S256;服务端 rewrite 注入
 *      prompt=consent,用户看到品牌确认页,点 Allow)
 *   3. loopback(127.0.0.1 固定端口池)接回 code → token 端点换 access token
 *      (form-urlencoded!)
 *   4. access token → POST /api/v1/auth/exchange 换该用户的长期 API key,
 *      写入 ~/.web2md/config.json —— 之后与 API key 用户完全同路
 *
 * 为什么落地成 API key 而不是存 token:v1 端点统一走 key 认证(单一路径),
 * 且免去 stdio 场景的 refresh 管理。OAuth 是前门,key 是会话。
 */
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const SITE = process.env.WEB2MD_SITE_URL || 'https://web2md.org'
const CONFIG_DIR = join(homedir(), '.web2md')
const CLIENT_CACHE = join(CONFIG_DIR, 'oauth-client.json')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

// 固定端口池:DCR 要求 redirect_uri 精确匹配,把整个池都注册进去,
// 运行时挑一个能 bind 的。
const PORTS = [41763, 41764, 41765, 41766]
// 深坑(2026-09-05 实测):Vercel/Next 层会把 query 里的 127.0.0.1 规范化成
// localhost,和注册的 URI 精确匹配就挂。顺势统一用 localhost(RFC 8252 同样
// 允许;本地监听仍绑 127.0.0.1,localhost 解析到它)。
const redirectUri = (port: number) => `http://localhost:${port}/callback`

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * 品牌化的 loopback 回调页(2026-09-05,用户嫌旧版丑)。
 * 复刻 web2md 官网调性:暗底 + 金色 aurora 光晕 + .MD 金框标 + Georgia serif 标题
 * + 成功勾。self-contained(loopback 无网络,不能引外部资源)。
 */
function resultPage(ok: boolean, title: string, body: string): string {
  const GOLD = '#c9a227'
  const icon = ok
    ? `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${GOLD}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`
    : `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#c77" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Web2MD</title><style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background:#14110f; color:#f5f3ef; position:relative; overflow:hidden; }
    /* 金色 aurora 光晕(取自官网 promo bar 背景) */
    body::before { content:''; position:absolute; inset:0; z-index:0; pointer-events:none;
      background:
        radial-gradient(60% 120% at 20% 115%, rgba(201,162,39,0.22), transparent 70%),
        radial-gradient(50% 110% at 55% -30%, rgba(201,162,39,0.16), transparent 68%),
        radial-gradient(55% 120% at 85% 120%, rgba(180,130,55,0.18), transparent 72%); }
    .card { position:relative; z-index:1; text-align:center; max-width:30rem; padding:2.5rem 2rem; }
    .badge { display:inline-flex; align-items:center; justify-content:center; width:56px; height:56px;
      border-radius:14px; margin-bottom:1.5rem;
      background:rgba(201,162,39,0.08); border:1px solid rgba(201,162,39,0.45);
      box-shadow:0 0 20px rgba(201,162,39,0.2); }
    .brand { display:flex; align-items:center; justify-content:center; gap:.5rem; margin-bottom:1.25rem; }
    .brand .mark { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px;
      border-radius:6px; background:#1e1a15; border:1px solid rgba(201,162,39,0.6);
      font-family:Georgia,serif; font-weight:700; font-size:.62rem; color:${GOLD};
      box-shadow:0 0 8px rgba(201,162,39,0.35); }
    .brand .name { font-family:Georgia,"Times New Roman",serif; font-size:1.15rem; color:#f5f3ef; letter-spacing:.01em; }
    h1 { font-family:Georgia,"Times New Roman",serif; font-weight:600; font-size:1.6rem; margin:0 0 .6rem; color:#f5f3ef; }
    p { margin:0; color:#b8ad9c; font-size:.98rem; line-height:1.65; }
  </style></head><body><div class="card">
    <div class="badge">${icon}</div>
    <div class="brand"><span class="mark">.MD</span><span class="name">Web2MD</span></div>
    <h1>${title}</h1>
    <p>${body}</p>
  </div></body></html>`
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* 打不开就靠终端里打印的链接 */
  }
}

/** DCR 注册(或读缓存)公共客户端。 */
async function ensureClient(): Promise<string> {
  try {
    const cached = JSON.parse(readFileSync(CLIENT_CACHE, 'utf-8')) as { clientId?: string }
    if (cached.clientId) return cached.clientId
  } catch { /* 无缓存,走注册 */ }

  const res = await fetch(`${SITE}/api/auth/mcp/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Web2MD CLI / local MCP',
      redirect_uris: PORTS.map(redirectUri),
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  })
  if (!res.ok) throw new Error(`Client registration failed: HTTP ${res.status}`)
  const data = (await res.json()) as { client_id?: string }
  if (!data.client_id) throw new Error('Client registration returned no client_id')
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CLIENT_CACHE, JSON.stringify({ clientId: data.client_id }, null, 2) + '\n')
  return data.client_id
}

/**
 * 完整 OAuth 登录,成功后把 API key 写入 ~/.web2md/config.json 并返回。
 */
export async function oauthLogin(log: (m: string) => void = (m) => console.error(m)): Promise<string> {
  const clientId = await ensureClient()

  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const state = b64url(randomBytes(24))

  // 先确定端口(bind 成功那个),再拼授权 URL —— listenForCode 在 resolve 时
  // 告知端口,但授权 URL 要先发出。改为:先探测可用端口,再监听同一端口。
  // 简化:listenForCode 内部逐个试,授权 URL 用它实际 bind 的端口 ——
  // 通过先启动监听、拿到端口后再开浏览器实现。
  let resolvePort: (p: number) => void
  const portReady = new Promise<number>((r) => { resolvePort = r })
  const codePromise = listenForCodeWithPort(state, (p) => resolvePort(p))
  const port = await portReady

  const authUrl = new URL(`${SITE}/api/auth/mcp/authorize`)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri(port))
  authUrl.searchParams.set('code_challenge', challenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('scope', 'openid profile email')
  authUrl.searchParams.set('state', state)

  log('Opening your browser to sign in to Web2MD…')
  log(`If it does not open, visit:\n  ${authUrl.toString()}`)
  openBrowser(authUrl.toString())

  const { code } = await codePromise

  // token 交换 —— 必须 form-urlencoded
  const tokenRes = await fetch(`${SITE}/api/auth/mcp/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(port),
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  })
  if (!tokenRes.ok) {
    const t = await tokenRes.text()
    throw new Error(`Token exchange failed: HTTP ${tokenRes.status} ${t.slice(0, 200)}`)
  }
  const tok = (await tokenRes.json()) as { access_token?: string }
  if (!tok.access_token) throw new Error('Token response missing access_token')

  // access token → 长期 API key
  const exRes = await fetch(`${SITE}/api/v1/auth/exchange`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}` },
  })
  if (!exRes.ok) throw new Error(`Key exchange failed: HTTP ${exRes.status}`)
  const ex = (await exRes.json()) as { apiKey?: string }
  if (!ex.apiKey) throw new Error('Exchange returned no apiKey')

  // 合并写 config.json(不覆盖其他字段)
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) } catch { /* 新建 */ }
  cfg.apiKey = ex.apiKey
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')

  log('✓ Signed in — credentials saved to ~/.web2md/config.json')
  return ex.apiKey
}

/** listenForCode 变体:bind 成功后立刻回调端口号(授权 URL 需要它)。 */
function listenForCodeWithPort(
  state: string,
  onPort: (port: number) => void
): Promise<{ code: string; port: number }> {
  return new Promise((resolve, reject) => {
    const tryPort = (idx: number) => {
      if (idx >= PORTS.length) return reject(new Error('No loopback port available'))
      const port = PORTS[idx]
      const server = createServer((req, res) => {
        const u = new URL(req.url || '/', `http://127.0.0.1:${port}`)
        if (u.pathname !== '/callback') { res.statusCode = 404; res.end(); return }
        const err = u.searchParams.get('error')
        const code = u.searchParams.get('code')
        const gotState = u.searchParams.get('state')
        if (err || !code || gotState !== state) {
          res.setHeader('Content-Type', 'text/html')
          res.end(resultPage(false, 'Sign-in failed', err || 'Something went wrong. Return to your terminal and try again.'))
          server.close(); reject(new Error(err || 'OAuth callback error'))
          return
        }
        res.setHeader('Content-Type', 'text/html')
        res.end(resultPage(true, "You're all set", 'Web2MD is connected. You can close this tab and return to your terminal.'))
        server.close(); resolve({ code, port })
      })
      server.on('error', () => tryPort(idx + 1))
      server.listen(port, '127.0.0.1', () => onPort(port))
      setTimeout(() => { try { server.close() } catch { /* */ } }, 300000).unref()
    }
    tryPort(0)
  })
}
