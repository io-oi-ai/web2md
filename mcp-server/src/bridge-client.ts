/**
 * Minimal Extension Bridge client for the MCP server.
 * Replicates the core logic from packages/cli/src/bridge.ts without the CLI dependency.
 */

import { createServer, Server } from 'node:http'
import { exec } from 'node:child_process'

const BRIDGE_PORT = 27832
const BRIDGE_TIMEOUT = 60000

export interface BridgeResult {
  html: string
  extractor: string
}

let _server: Server | null = null
let _serverStarted = false
let _pendingResolve: ((r: BridgeResult) => void) | null = null
let _pendingReject: ((e: Error) => void) | null = null
let _pendingTimeout: ReturnType<typeof setTimeout> | null = null

const MAC_BROWSER_APPS: Record<string, string> = {
  chrome: 'Google Chrome',
  arc: 'Arc',
  edge: 'Microsoft Edge',
  brave: 'Brave Browser',
  opera: 'Opera',
  vivaldi: 'Vivaldi',
  chromium: 'Chromium',
}

// Priority: WEB2MD_BRIDGE_BROWSER env override > browser slug from the account
// > OS default. Mirrors packages/cli/src/bridge.ts.
function openBrowser(url: string, browserSlug?: string | null): void {
  const platform = process.platform
  const envApp = process.env.WEB2MD_BRIDGE_BROWSER
  const slugApp = browserSlug ? MAC_BROWSER_APPS[browserSlug.toLowerCase()] : undefined
  const browserApp = envApp || slugApp
  const cmd =
    platform === 'darwin'
      ? (browserApp ? `open -a "${browserApp}" "${url}"` : `open "${url}"`) :
    platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`
  exec(cmd, () => {})
}

function buildBridgePage(extensionId: string, targetUrl: string): string {
  return `<!DOCTYPE html><html><head><title>Web2MD Bridge</title></head><body>
<p id="s">Connecting to Web2MD extension...</p>
<script>
const eid=${JSON.stringify(extensionId)},url=${JSON.stringify(targetUrl)},port=${BRIDGE_PORT};
function s(m){document.getElementById('s').textContent=m;}
function post(body){fetch('http://localhost:'+port+'/result',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
if(!chrome||!chrome.runtime){s('Extension API unavailable');post({error:'Chrome extension API not available'});}
else{s('Extracting...');chrome.runtime.sendMessage(eid,{type:'BRIDGE_CONVERT',url},(r)=>{
  if(chrome.runtime.lastError){const e=chrome.runtime.lastError.message||'Extension not found';s('Error: '+e);post({error:e});return;}
  if(!r||!r.success){const e=(r&&r.error)||'Unknown error';s('Error: '+e);post({error:e});return;}
  s('Sending...');post({html:r.html,extractor:r.extractor||'generic'}).then(()=>s('Done! Close this tab.'));
});}
</script></body></html>`
}

function ensureBridgeServer(): Promise<void> {
  if (_serverStarted && _server) return Promise.resolve()
  return new Promise((resolve, reject) => {
    _server = createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/bridge')) {
        const params = new URLSearchParams(req.url.slice('/bridge'.length))
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(buildBridgePage(params.get('eid') || '', params.get('url') || ''))
        return
      }
      if (req.method === 'POST' && req.url === '/result') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end('{"ok":true}')
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          if (_pendingTimeout) clearTimeout(_pendingTimeout)
          const rv = _pendingResolve
          const rj = _pendingReject
          _pendingResolve = _pendingReject = _pendingTimeout = null
          if (!rv || !rj) return
          try {
            const d = JSON.parse(body) as { html?: string; extractor?: string; error?: string }
            if (d.error) rj(new Error(`Bridge error: ${d.error}`))
            else if (d.html) rv({ html: d.html, extractor: d.extractor || 'generic' })
            else rj(new Error('Bridge returned empty response'))
          } catch { rj(new Error('Bridge returned invalid JSON')) }
        })
        return
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
        res.end(); return
      }
      res.writeHead(404); res.end()
    })
    _server.listen(BRIDGE_PORT, '127.0.0.1', () => { _serverStarted = true; resolve() })
    _server.on('error', (e: NodeJS.ErrnoException) => {
      reject(e.code === 'EADDRINUSE'
        ? new Error(`Port ${BRIDGE_PORT} in use. Is another web2md bridge running?`)
        : e)
    })
  })
}

export async function fetchViaExtension(url: string, extensionId: string, browser?: string | null): Promise<BridgeResult> {
  await ensureBridgeServer()
  return new Promise((resolve, reject) => {
    _pendingResolve = resolve
    _pendingReject = reject
    _pendingTimeout = setTimeout(() => {
      _pendingResolve = _pendingReject = _pendingTimeout = null
      reject(new Error('Bridge timeout: extension did not respond within 60s'))
    }, BRIDGE_TIMEOUT)
    const bridgeUrl = `http://localhost:${BRIDGE_PORT}/bridge?eid=${encodeURIComponent(extensionId)}&url=${encodeURIComponent(url)}`
    openBrowser(bridgeUrl, browser)
  })
}

export interface ExtensionTarget {
  extensionId: string
  browser: string | null
}

export async function resolveExtensionTarget(apiBase: string, apiKey: string): Promise<ExtensionTarget> {
  const envId = process.env.WEB2MD_EXTENSION_ID
  if (envId) return { extensionId: envId, browser: null }
  const res = await fetch(`${apiBase}/extension-id`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 404) throw new Error('No extension registered. Open web2md.org in your browser with the extension installed and logged in.')
  if (!res.ok) throw new Error(`Failed to look up extension ID: ${res.status}`)
  const data = await res.json() as { extensionId: string; browser?: string | null }
  return { extensionId: data.extensionId, browser: data.browser ?? null }
}

export function closeBridgeServer(): void {
  if (_server) { _server.close(); _server = null; _serverStarted = false }
}
