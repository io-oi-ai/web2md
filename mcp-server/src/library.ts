/**
 * Library HTTP client + node fs SyncDeps for the MCP server.
 * Talks to GET /api/v1/library and adapts the platform-agnostic
 * syncLibrary core (@web2md/shared) to the local filesystem.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { LibraryPage, SyncDeps, SyncState } from './vendor/sync'

const STATE_FILE = '.web2md-sync.json'

export interface LibraryClientOpts {
  apiBase: string // e.g. https://web2md.org/api
  apiKey: string
}

export interface LibraryQuery {
  q?: string
  tag?: string
  ids?: string[]
  sinceId?: string
  limit?: number
  fields?: 'meta'
  order?: 'asc' | 'desc'
}

export async function fetchLibraryPage(
  opts: LibraryClientOpts,
  query: LibraryQuery = {}
): Promise<LibraryPage> {
  const url = new URL(`${opts.apiBase}/v1/library`)
  if (query.q) url.searchParams.set('q', query.q)
  if (query.tag) url.searchParams.set('tag', query.tag)
  if (query.ids && query.ids.length > 0) url.searchParams.set('ids', query.ids.join(','))
  if (query.sinceId) url.searchParams.set('since_id', query.sinceId)
  if (query.limit) url.searchParams.set('limit', String(query.limit))
  if (query.fields) url.searchParams.set('fields', query.fields)
  if (query.order) url.searchParams.set('order', query.order)

  const resp = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      'User-Agent': 'web2md-mcp',
    },
    signal: AbortSignal.timeout(60000),
  })

  if (resp.status === 401) throw new Error('Invalid or revoked API key')
  if (!resp.ok) {
    const body = (await resp.json().catch(() => ({}))) as { error?: string }
    throw new Error(`API error ${resp.status}${body.error ? `: ${body.error}` : ''}`)
  }
  return (await resp.json()) as LibraryPage
}

/**
 * Validate a sync target directory: must be an absolute path with no `..`
 * segments in the raw input. Returns the resolved absolute path.
 */
export function validateSyncDir(dir: string): string {
  if (!path.isAbsolute(dir)) {
    throw new Error(`dir must be an absolute path, got: ${dir}`)
  }
  if (dir.split(/[\\/]/).includes('..')) {
    throw new Error(`dir contains path traversal: ${dir}`)
  }
  return path.resolve(dir)
}

/** Node fs SyncDeps writing into `dir`; state file format matches the CLI. */
export function makeFsSyncDeps(dir: string, opts: LibraryClientOpts): SyncDeps {
  const statePath = path.join(dir, STATE_FILE)

  return {
    async fetchPage({ sinceId, tag, limit }) {
      return fetchLibraryPage(opts, { sinceId, tag, limit })
    },

    async readState() {
      try {
        return JSON.parse(await fs.readFile(statePath, 'utf-8')) as SyncState
      } catch {
        return null
      }
    },

    async writeState(s: SyncState) {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(statePath, JSON.stringify(s, null, 2) + '\n', 'utf-8')
    },

    async writeFile(relPath: string, content: string) {
      const abs = path.join(dir, relPath)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf-8')
    },

    async exists(relPath: string) {
      try {
        await fs.access(path.join(dir, relPath))
        return true
      } catch {
        return false
      }
    },
  }
}
