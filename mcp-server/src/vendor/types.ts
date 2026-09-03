export interface LibraryItem {
  id: string
  url: string
  title: string | null
  markdown?: string
  tags: string[]
  createdAt: string // ISO
}

export interface LibraryPage {
  items: LibraryItem[]
  nextCursor: string | null
  plan: 'FREE' | 'PRO'
  truncated: boolean
}

export interface SyncState {
  lastId: string | null
  lastSyncAt: string | null
  fileIndex: Record<string, string> // web2md_id -> relative path
}

export interface SyncDeps {
  fetchPage(params: { sinceId?: string; tag?: string; limit?: number }): Promise<LibraryPage>
  readState(): Promise<SyncState | null>
  writeState(s: SyncState): Promise<void>
  writeFile(relPath: string, content: string): Promise<void>
  exists(relPath: string): Promise<boolean>
}

export interface SyncResult {
  added: number
  skipped: number
  failed: number
  errors: string[] // "<id>: <message>"
  truncated: boolean
  plan: 'FREE' | 'PRO'
  files: string[]
}
