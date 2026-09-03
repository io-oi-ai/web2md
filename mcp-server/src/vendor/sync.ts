import type { LibraryItem, SyncDeps, SyncResult, SyncState } from './types'
import { slugify } from './slug'

export interface SyncOptions {
  tag?: string
  full?: boolean
}

// TODO: 完整 YAML 转义(反斜杠、换行、tags 内特殊字符)——目前只转义 title 双引号
function frontmatter(item: LibraryItem, date: string): string {
  const title = (item.title || 'untitled').replace(/"/g, '\\"')
  return [
    '---',
    `source: ${item.url}`,
    `web2md_id: ${item.id}`,
    `date: ${date}`,
    `tags: [${item.tags.join(', ')}]`,
    `title: "${title}"`,
    '---',
    '',
    item.markdown ?? '',
  ].join('\n')
}

/**
 * 平台无关的 Library 增量同步核心。
 * 游标只在整页全部处理完并 writeState 成功后前移,重跑安全。
 */
export async function syncLibrary(deps: SyncDeps, opts: SyncOptions = {}): Promise<SyncResult> {
  const state = (await deps.readState()) ?? { lastId: null, lastSyncAt: null, fileIndex: {} }
  const fileIndex: Record<string, string> = { ...state.fileIndex }
  const usedPaths = new Set(Object.values(fileIndex))

  const result: SyncResult = {
    added: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    truncated: false,
    plan: 'FREE',
    files: [],
  }

  let cursor: string | undefined = opts.full ? undefined : state.lastId ?? undefined

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await deps.fetchPage({ sinceId: cursor, tag: opts.tag, limit: 100 })
    result.plan = page.plan
    if (page.truncated) result.truncated = true
    if (page.items.length === 0) break

    for (const item of page.items) {
      if (fileIndex[item.id]) {
        result.skipped++
        continue
      }
      if (item.markdown === undefined) {
        result.skipped++
        continue
      }

      const date = item.createdAt.slice(0, 10)
      // 消毒 tag,防止 ../ 或 / 造成路径穿越
      const dir = slugify(item.tags[0] || '') || 'untagged'
      const slug = slugify(item.title || 'untitled') || 'untitled'
      const taken = async (p: string) => usedPaths.has(p) || deps.exists(p)
      let relPath = `${dir}/${date}-${slug}.md`
      if (await taken(relPath)) {
        relPath = `${dir}/${date}-${slug}-${item.id.slice(-4)}.md`
        if (await taken(relPath)) {
          relPath = `${dir}/${date}-${slug}-${item.id}.md`
        }
      }

      try {
        await deps.writeFile(relPath, frontmatter(item, date))
      } catch (err) {
        result.failed++
        result.errors.push(`${item.id}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      fileIndex[item.id] = relPath
      usedPaths.add(relPath)
      result.added++
      result.files.push(relPath)
    }

    // 整页处理完后才前移游标
    const newState: SyncState = {
      lastId: page.items[page.items.length - 1]!.id,
      lastSyncAt: new Date().toISOString(),
      fileIndex,
    }
    await deps.writeState(newState)

    if (!page.nextCursor) break
    cursor = page.nextCursor
  }

  return result
}

export type { LibraryItem, LibraryPage, SyncDeps, SyncResult, SyncState } from './types'
