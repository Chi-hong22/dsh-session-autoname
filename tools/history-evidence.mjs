/**
 * Read-only history evidence extractor.
 *
 * Decodes every concatenated zstd frame of each root session log under
 * `.dsh/sessions`, keeps sessions created inside the reporting window, and
 * prints one compact first-turn digest per session: the eligible human first
 * message (the same rule the title service applies), the assistant's final text
 * of that turn, and the tools it used. Nothing is written.
 *
 *   node tools/history-evidence.mjs [sinceEpochMs]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS_ROOT = 'C:\\Users\\Chihong\\.dsh\\sessions'
const PROJ_CACHE = 'C:\\Users\\Chihong\\.dsh\\storages\\session_projcache\\sessions'
const since = Number(process.argv[2] ?? 0)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode every concatenated zstd frame of one log into its JSONL text. */
function decodeFrames(buf) {
  const parts = []
  let at = buf.indexOf(MAGIC, 0)
  while (at !== -1) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(at)).toString('utf8'))
    } catch {
      // A magic-byte lookalike inside compressed data: not a frame boundary.
    }
    at = buf.indexOf(MAGIC, at + 4)
  }
  return parts.join('')
}

function* walkLogs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkLogs(path)
    else if (entry.name.endsWith('.jsonl.zstd')) yield path
  }
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function cut(text, max) {
  const flat = text.replace(/\s+/gu, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** Current folded title from the projection cache, for old -> new comparison. */
function cachedTitle(id) {
  try {
    const doc = JSON.parse(readFileSync(join(PROJ_CACHE, `${id}.json`), 'utf8'))
    return doc?.record?.rows?.title?.val ?? null
  } catch {
    return null
  }
}

const rows = []
for (const file of walkLogs(SESSIONS_ROOT)) {
  const records = decodeFrames(readFileSync(file))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  const header = records.find((record) => record.type === 'session')
  if (header === undefined) continue
  if (header.parentSession !== undefined || header.origin === 'subagent') continue
  if (header.delegationDepth !== undefined && header.delegationDepth > 0) continue
  if (header.createdAt < since) continue

  const users = []
  const assistants = []
  const tools = new Map()
  let closed = false
  for (const record of records) {
    if (record.type === 'session') continue
    if (record.type === 'turn/end') {
      if (record.data?.turn === 1) closed = true
      continue
    }
    if (record.type === 'user/message') {
      if (record.data?.source?.kind !== 'user') continue
      const text = textOf(record.data.content)
      if (text.length > 0) users.push(text)
      continue
    }
    if (record.type === 'assistant/message') {
      const text = textOf(record.data?.message?.content)
      if (text.length > 0) assistants.push(text)
      continue
    }
    if (record.type === 'tool/call' && typeof record.data?.name === 'string') {
      tools.set(record.data.name, (tools.get(record.data.name) ?? 0) + 1)
    }
  }
  rows.push({
    id: header.id,
    mmdd: shanghai.format(new Date(header.createdAt)).replace(/-/gu, '').slice(4),
    cwd: header.cwd ?? '',
    closed,
    title: cachedTitle(header.id),
    users,
    final: assistants.at(-1) ?? '',
    tools: [...tools].map(([name, count]) => `${name}x${count}`),
  })
}

rows.sort((a, b) => (a.mmdd < b.mmdd ? 1 : a.mmdd > b.mmdd ? -1 : a.id < b.id ? 1 : -1))
for (const row of rows) {
  console.log(`=== ${row.mmdd} | ${row.id.replace('session-', '').slice(0, 8)} | ${row.cwd.split(/[\\/]/u).filter(Boolean).at(-1)} | closed=${row.closed}`)
  console.log(`OLD: ${row.title ?? '(none)'}`)
  console.log(`USER: ${cut(row.users.join(' // '), 260) || '(no eligible human message)'}`)
  console.log(`FINAL: ${cut(row.final, 320) || '(no assistant text)'}`)
  console.log(`TOOLS: ${row.tools.join(', ') || '-'}`)
}
console.error(`sessions: ${rows.length}`)
