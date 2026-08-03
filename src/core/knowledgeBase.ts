import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join, extname, basename } from 'path'
import { randomUUID } from 'crypto'

export interface KnowledgeEntry {
  id: string
  title: string
  category: string
  content: string
  tags: string[]
  createdAt: number
}

export class KnowledgeBase {
  private entries: Map<string, KnowledgeEntry>

  constructor(knowledgeDir?: string) {
    this.entries = new Map()
    if (knowledgeDir && existsSync(knowledgeDir)) {
      this.loadFromDirectory(knowledgeDir)
    }
  }

  loadFromDirectory(dir: string): void {
    if (!existsSync(dir)) return
    const files = readdirSync(dir).filter((f) => {
      const ext = extname(f).toLowerCase()
      return ext === '.md' || ext === '.txt'
    })
    for (const file of files) {
      const filePath = join(dir, file)
      const stat = statSync(filePath)
      if (!stat.isFile()) continue
      const raw = readFileSync(filePath, 'utf-8')
      const name = basename(file, extname(file))
      const lines = raw.split('\n')
      let title = name
      let content = raw
      if (lines.length > 0 && lines[0].startsWith('# ')) {
        title = lines[0].replace(/^#\s+/, '').trim()
        content = lines.slice(1).join('\n').trim()
      }
      const category = this.inferCategory(name)
      const tags = this.extractTags(name, raw)
      const entry: KnowledgeEntry = {
        id: randomUUID(),
        title,
        category,
        content,
        tags,
        createdAt: stat.birthtimeMs || Date.now(),
      }
      this.entries.set(entry.id, entry)
    }
  }

  addEntry(entry: Omit<KnowledgeEntry, 'id' | 'createdAt'>): KnowledgeEntry {
    const full: KnowledgeEntry = {
      ...entry,
      id: randomUUID(),
      createdAt: Date.now(),
    }
    this.entries.set(full.id, full)
    return full
  }

  search(query: string): KnowledgeEntry[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return []
    const results: KnowledgeEntry[] = []
    for (const entry of this.entries.values()) {
      const haystack = `${entry.title} ${entry.content} ${entry.tags.join(' ')}`.toLowerCase()
      if (terms.some((t) => haystack.includes(t))) {
        results.push(entry)
      }
    }
    return results
  }

  getByCategory(category: string): KnowledgeEntry[] {
    const cat = category.toLowerCase()
    return [...this.entries.values()].filter((e) => e.category.toLowerCase() === cat)
  }

  getById(id: string): KnowledgeEntry | undefined {
    return this.entries.get(id)
  }

  listAll(): KnowledgeEntry[] {
    return [...this.entries.values()]
  }

  private inferCategory(filename: string): string {
    const name = filename.toLowerCase()
    if (name.includes('sqli') || name.includes('sql')) return 'web'
    if (name.includes('xss')) return 'web'
    if (name.includes('upload')) return 'web'
    if (name.includes('command') || name.includes('cmdi')) return 'web'
    if (name.includes('post') || name.includes('exploit')) return 'post-exploitation'
    if (name.includes('crypto')) return 'crypto'
    if (name.includes('forensic')) return 'forensics'
    return 'general'
  }

  private extractTags(filename: string, content: string): string[] {
    const tags = new Set<string>()
    const name = filename.toLowerCase()
    if (name.includes('sqli')) tags.add('sqli')
    if (name.includes('xss')) tags.add('xss')
    if (name.includes('upload')) tags.add('file-upload')
    if (name.includes('command')) tags.add('command-injection')
    if (name.includes('post')) tags.add('post-exploitation')
    if (name.includes('crypto')) tags.add('crypto')
    if (name.includes('forensic')) tags.add('forensics')
    const tagMatch = content.match(/tags?:\s*(.+)/i)
    if (tagMatch) {
      tagMatch[1].split(/[,;\s]+/).forEach((t) => {
        const trimmed = t.trim().toLowerCase()
        if (trimmed) tags.add(trimmed)
      })
    }
    return [...tags]
  }
}
