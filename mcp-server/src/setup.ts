#!/usr/bin/env node
/**
 * web2md-mcp-setup — 一条命令接入所有 Agent(2026-09-03,用户拍板)。
 *
 * 设计原则:用户不该区分自己用的是哪个 Agent。识别客户端是安装器的活:
 *   1. 注册 native messaging host(复用 install.sh/bat,自动发现扩展 ID)
 *   2. 探测本机已装的 Agent,挨个写好 MCP 配置:
 *      - claude CLI      → `claude mcp add web2md -s user -- web2md-mcp-server`
 *      - codex CLI       → `codex mcp add web2md -- web2md-mcp-server`
 *      - Claude Desktop  → 合并写 claude_desktop_config.json
 *      - Cursor          → 合并写 ~/.cursor/mcp.json
 *   3. 汇总报告:配置了哪些、跳过了哪些(没装的)
 *
 * API key 不写进任何配置 —— MCP server 自己会从 ~/.web2md/config.json 读
 * (`web2md login` 写入),所以配置里只需要命令本身。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const isWindows = platform() === 'win32'
const isMac = platform() === 'darwin'

function fail(msg: string): never {
  console.error(`\n❌ ${msg}`)
  process.exit(1)
}

/** `web2md login` 写入的本地配置(API key)。 */
function readApiKey(): string | undefined {
  if (process.env.WEB2MD_API_KEY) return process.env.WEB2MD_API_KEY
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.web2md', 'config.json'), 'utf-8'))
    return typeof cfg.apiKey === 'string' ? cfg.apiKey : undefined
  } catch {
    return undefined
  }
}

async function discoverExtId(apiKey: string): Promise<string> {
  const apiBase = process.env.WEB2MD_API_BASE || 'https://web2md.org'
  const res = await fetch(`${apiBase}/api/extension-id`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 404) {
    fail('No extension registered for your account. Install the Web2MD extension and sign in, then re-run.')
  }
  if (!res.ok) fail(`Failed to discover extension ID: HTTP ${res.status}`)
  const { extensionId } = (await res.json()) as { extensionId?: string }
  if (!extensionId) fail('Backend returned no extension ID. Sign in inside the extension, then retry.')
  return extensionId
}

/** 注册 native messaging host(与 web2md-mcp-server-install 相同的脚本)。 */
function registerNativeHost(extId: string): Promise<boolean> {
  const pkgRoot = resolve(__dirname, '..')
  const scriptPath = isWindows ? join(pkgRoot, 'install.bat') : join(pkgRoot, 'install.sh')
  if (!existsSync(scriptPath)) {
    fail(`Installer script missing at ${scriptPath}. Reinstall: npm i -g web2md-mcp-server@latest`)
  }
  const cmd = isWindows ? 'cmd.exe' : 'bash'
  const args = isWindows ? ['/c', scriptPath, extId] : [scriptPath, extId]
  return new Promise((res) => {
    const child = spawn(cmd, args, { stdio: 'inherit', cwd: pkgRoot })
    child.on('error', () => res(false))
    child.on('exit', (code) => res(code === 0))
  })
}

/**
 * MCP server 的启动方式 —— 一律用绝对路径。
 * 深坑(2026-09-03 真机验收抓到):包名 web2md-mcp-server 的 bin 命令其实叫
 * web2md-mcp;而且 GUI 应用(Claude Desktop/Cursor)的 PATH 根本没有 npm
 * 全局 bin(macOS 上连 homebrew 都没有)。裸命令名必 ENOENT。
 * process.execPath(当前 node 绝对路径)+ dist/index.js 绝对路径对谁都防弹。
 */
function serverInvocation(): { command: string; args: string[] } {
  const pkgRoot = resolve(__dirname, '..')
  return { command: process.execPath, args: [join(pkgRoot, 'dist', 'index.js')] }
}

/** CLI 是否可用(claude / codex)。 */
function hasCli(name: string): boolean {
  const probe = spawnSync(isWindows ? 'where' : 'which', [name], { stdio: 'ignore' })
  return probe.status === 0
}

/** 跑 `<cli> mcp add …`,已存在同名条目视为成功(幂等)。 */
function cliMcpAdd(cli: string, args: string[]): boolean {
  const r = spawnSync(cli, args, { encoding: 'utf-8' })
  if (r.status === 0) return true
  const out = `${r.stdout || ''}${r.stderr || ''}`.toLowerCase()
  return out.includes('already exists') || out.includes('already configured')
}

/** 合并写 JSON 配置文件的 mcpServers.web2md(Claude Desktop / Cursor 共用)。 */
function mergeJsonConfig(file: string): boolean {
  try {
    let cfg: Record<string, unknown> = {}
    if (existsSync(file)) {
      cfg = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
    }
    const servers = (cfg.mcpServers && typeof cfg.mcpServers === 'object'
      ? cfg.mcpServers
      : {}) as Record<string, unknown>
    servers.web2md = serverInvocation()
    cfg.mcpServers = servers
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

function claudeDesktopConfigPath(): string {
  if (isMac) return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (isWindows) return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

async function main() {
  console.log('web2md-mcp-setup — connecting all your Agents…\n')

  let apiKey = readApiKey()
  if (!apiKey) {
    // 无凭证 → 直接发起 OAuth 浏览器登录(2026-09-05),一条命令彻底自包含,
    // 不再要求先跑 web2md-cli login。
    console.log('No credentials found — signing you in via browser…')
    const { oauthLogin } = await import('./oauth.js')
    apiKey = await oauthLogin((m) => console.log(m))
  }

  // 1) native host(本地 Agent 桥,扩展端状态灯的那条链路)
  console.log('▸ Registering local Agent bridge (native messaging host)…')
  const extId = await discoverExtId(apiKey)
  const hostOk = await registerNativeHost(extId)
  console.log(hostOk ? '  ✓ native host registered' : '  ✗ native host registration failed (MCP tools still work without it)')

  // 2) 逐客户端配置(装了才配,没装静默跳过)
  const done: string[] = []
  const skipped: string[] = []

  const inv = serverInvocation()
  if (hasCli('claude')) {
    cliMcpAdd('claude', ['mcp', 'remove', 'web2md', '-s', 'user'])  // 幂等:先清旧条目(可能存着坏命令名)
    cliMcpAdd('claude', ['mcp', 'add', 'web2md', '-s', 'user', '--', inv.command, ...inv.args])
      ? done.push('Claude Code')
      : skipped.push('Claude Code (add failed — run `claude mcp add web2md -s user -- node <path-to>/dist/index.js` manually)')
  } else skipped.push('Claude Code (not installed)')

  if (hasCli('codex')) {
    cliMcpAdd('codex', ['mcp', 'remove', 'web2md'])
    cliMcpAdd('codex', ['mcp', 'add', 'web2md', '--', inv.command, ...inv.args])
      ? done.push('Codex')
      : skipped.push('Codex (add failed — run `codex mcp add web2md -- node <path-to>/dist/index.js` manually)')
  } else skipped.push('Codex (not installed)')

  const claudeDesktop = claudeDesktopConfigPath()
  if (existsSync(dirname(claudeDesktop))) {
    mergeJsonConfig(claudeDesktop) ? done.push('Claude Desktop') : skipped.push('Claude Desktop (config write failed)')
  } else skipped.push('Claude Desktop (not installed)')

  const cursorCfg = join(homedir(), '.cursor', 'mcp.json')
  if (existsSync(join(homedir(), '.cursor'))) {
    mergeJsonConfig(cursorCfg) ? done.push('Cursor') : skipped.push('Cursor (config write failed)')
  } else skipped.push('Cursor (not installed)')

  // 3) 汇总
  console.log('\n═══ Setup summary ═══')
  for (const d of done) console.log(`  ✓ ${d}`)
  for (const s of skipped) console.log(`  – ${s}`)
  if (done.length === 0) {
    console.log('\nNo Agent clients found on this machine. Install Claude Code / Codex / Cursor / Claude Desktop and re-run.')
  } else {
    console.log(`\n✅ ${done.length} Agent${done.length > 1 ? 's' : ''} connected to Web2MD.`)
    console.log('Restart the configured apps (and fully quit + reopen Chrome for the local bridge).')
  }
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)))
