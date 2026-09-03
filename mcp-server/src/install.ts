#!/usr/bin/env node

/**
 * web2md-mcp-server-install — one-shot installer that delegates to the
 * platform-specific shell/batch script bundled in the package root.
 *
 * Usage:
 *   npx web2md-mcp-server-install <chrome-extension-id>
 *
 * Why this exists: the .sh / .bat installers need to know where the
 * package lives on disk, and users shouldn't have to compute that.
 * This wrapper locates the package via __dirname and invokes the right
 * script with the user's extension id.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { platform, homedir } from 'node:os'

function fail(msg: string, code = 1): never {
  console.error(msg)
  process.exit(code)
}

const HELP = `Usage: web2md-mcp-server-install [chrome-extension-id]

With no id, the installer auto-discovers your extension ID using your API key
(from WEB2MD_API_KEY or ~/.web2md/config.json) — run \`web2md login\` first.
Pass an id explicitly to override.

This registers the native messaging host so Agent Bridge tools
(agent_convert, agent_batch_convert, bridge_convert_url) can reach the
extension via TCP on 127.0.0.1:12315.

After install, fully quit Chrome (Cmd+Q / system-tray on Windows) and reopen.`

/** Read API key from env or ~/.web2md/config.json. */
function readApiKey(): string | undefined {
  if (process.env.WEB2MD_API_KEY) return process.env.WEB2MD_API_KEY
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.web2md', 'config.json'), 'utf-8'))
    return typeof cfg.apiKey === 'string' ? cfg.apiKey : undefined
  } catch {
    return undefined
  }
}

/** Auto-discover the extension ID from the account via the API key. */
async function discoverExtId(apiBase: string, apiKey: string): Promise<string> {
  const res = await fetch(`${apiBase}/api/extension-id`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 404) {
    fail('No extension registered for your account. Install the Web2MD extension in your browser and log in, then re-run this command.')
  }
  if (!res.ok) fail(`Failed to auto-discover extension ID: ${res.status}`)
  const { extensionId } = (await res.json()) as { extensionId?: string }
  if (!extensionId) fail('Backend returned no extension ID. Open your browser with the extension logged in, then retry.')
  return extensionId
}

const arg = process.argv[2]
if (arg === '--help' || arg === '-h') {
  console.log(HELP)
  process.exit(0)
}

async function main() {
  let extId = arg
  if (!extId) {
    const apiKey = readApiKey()
    if (!apiKey) {
      fail(HELP + '\n\nNo extension ID given and no API key found. Run `web2md login` first, or pass the id explicitly.')
    }
    const apiBase = process.env.WEB2MD_API_BASE || 'https://web2md.org'
    console.log('No extension ID given — auto-discovering via your account...')
    extId = await discoverExtId(apiBase, apiKey!)
    console.log(`Discovered extension ID: ${extId}`)
  }

  // We live at <pkg>/dist/install.js after build; install.sh / install.bat
  // sit at <pkg>/install.sh and <pkg>/install.bat.
  const pkgRoot = resolve(__dirname, '..')
  const isWindows = platform() === 'win32'
  const scriptPath = isWindows ? join(pkgRoot, 'install.bat') : join(pkgRoot, 'install.sh')

  if (!existsSync(scriptPath)) {
    fail(`Installer script not found at ${scriptPath}. Reinstall with:
  npm install -g web2md-mcp-server@latest`)
  }

  const cmd = isWindows ? 'cmd.exe' : 'bash'
  const args = isWindows ? ['/c', scriptPath, extId] : [scriptPath, extId]

  const child = spawn(cmd, args, { stdio: 'inherit', cwd: pkgRoot })
  child.on('error', (err) => fail(`Failed to launch installer: ${err.message}`))
  child.on('exit', (code) => process.exit(code ?? 1))
}

main().catch((err) => fail(`Install failed: ${err instanceof Error ? err.message : String(err)}`))
