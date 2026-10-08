/**
 * Offline verification of the plugin's own logic, driven through the real
 * `apply()` surface with a fake Cordis context: no host, no model, no network.
 *
 *   node --test tests/provider.test.mjs
 *
 * Covers the acceptance rules the hook port must enforce (date from createdAt in
 * Asia/Shanghai, the ten types, full-width separator, topic budget, strict JSON,
 * project-name exclusion), the first-turn trigger's skip conditions, the admin
 * tool's write path, and whole-conversation summarization.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, name, inject } from '../session-naming.js'

const SEP = '\uFF5C'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Build one session event log.
 * @param turns - one entry per turn: its human prompt, the assistant's final
 * text, the tools it called, and the turn's end reason kind.
 */
function buildLog(turns, { title } = {}) {
  const log = []
  const push = (type, data) => log.push({ type, data, seq: log.length, time: 0 })
  push('request/header', { header: { config: { provider: 'p', model: 'm' } }, reason: 'initial' })
  for (const [index, turn] of turns.entries()) {
    const n = index + 1
    push('turn/start', { turn: n })
    push('user/message', {
      role: 'user',
      content: [{ type: 'text', text: turn.prompt }],
      source: { kind: 'user' },
    })
    for (const tool of turn.tools ?? []) {
      push('tool/call', { turn: n, step: 1, callId: tool, name: tool, arguments: '{}' })
    }
    if (turn.assistant !== undefined) {
      push('assistant/message', {
        turn: n,
        step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: turn.assistant }], source: { kind: 'model' } },
      })
    }
    // `end: 'open'` models a log killed mid-turn: the turn never closes.
    if (turn.end !== 'open') push('turn/end', { turn: n, reason: { kind: turn.end ?? 'completed' } })
  }
  if (title !== undefined) push('session/title', { title: title.title, source: title.source, messageSeqs: [] })
  return log
}

const FIRST_TURN = [{ prompt: '请修复登录报错', assistant: '已修复并验证通过', tools: ['pwsh'] }]

/** Build one live-session stand-in backed by a fixed event log. */
function fakeSession({ createdAt, cwd = 'D:\\__CODE__\\demo', log = buildLog(FIRST_TURN) } = {}) {
  return {
    id: 'session-test',
    header: { id: 'session-test', createdAt, cwd },
    snapshotEvents: () => log,
  }
}

/**
 * Build the fake host context.
 * @param reply - the raw text the fake model streams back.
 * @param currentTitle - the title the session already carries, if any.
 */
function fakeContext({
  reply = `{"title":"1002${SEP}功能${SEP}演示主题"}`,
  finish = 'stop',
  sessions = [],
  query,
  controller,
  timer = { timeout: (callback) => { queueMicrotask(callback); return () => {} } },
} = {}) {
  const captured = { renames: [], listeners: {} }
  const ctx = {
    get: (key) => {
      if (key === 'sessions') return { get: (id) => sessions.find((s) => s.id === id) }
      if (key === 'sessionQuery') return query
      if (key === 'sessionController') return controller
      if (key === 'timer') return timer ?? undefined
      return undefined
    },
    effect: (fn) => {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    on: (event, listener) => {
      captured.listeners[event] = listener
      return () => {}
    },
    logger: { warn: () => {} },
    sessionTitle: {
      rename: (session, title) => {
        captured.renames.push({ session, title })
        return { title, eventSeq: 1 }
      },
    },
    llm: {
      stream(options) {
        captured.request = options
        const chunks = [{ type: 'text-delta', index: 0, text: reply }, { type: 'finish', reason: { kind: finish } }]
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
    tools: {
      register(definition) {
        captured.tool = definition
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

/**
 * Drive one automatic naming attempt and report what it wrote.
 * @param overrides.triggerTurn - the turn whose `turn/end` fires the trigger.
 */
async function runAuto(options, overrides = {}) {
  const session =
    overrides.session ?? fakeSession({ createdAt: overrides.createdAt ?? Date.UTC(2026, 9, 2, 1, 0, 0) })
  // A live trigger always has its session in the live store; that is what makes
  // the write go through `sessionTitle.rename` instead of a resume.
  const { ctx, captured } = fakeContext({ ...options, sessions: [session] })
  apply(ctx)
  captured.listeners['session/event'](session, {
    type: 'turn/end',
    data: { turn: overrides.triggerTurn ?? 1, reason: { kind: 'completed' } },
    seq: 999,
  })
  await sleep(30)
  return {
    renamed: captured.renames.length > 0,
    title: captured.renames[0]?.title,
    captured,
  }
}

test('applies without a timer service, losing only the catch-up', async () => {
  // The naming trigger and the admin tool must never depend on the optional
  // catch-up being schedulable.
  const { ctx, captured } = fakeContext({
    timer: null,
    query: { listSessions: async () => [], readTitleSnapshots: async () => [] },
  })
  apply(ctx)
  assert.equal(typeof captured.listeners['session/event'], 'function')
  assert.equal(captured.tool.name, 'session_title_admin')
  const listed = await captured.tool.execute({ action: 'list' })
  assert.ok(
    listed.auto.recent.some((entry) => entry.outcome === 'sweep' && /timer service unavailable/.test(entry.detail)),
    'the skipped catch-up must say why',
  )
})

test('plugin surface: name, inject, first-turn trigger, and one admin tool', () => {
  const { ctx, captured } = fakeContext({})
  apply(ctx)
  assert.equal(name, 'dsh-session-autoname')
  assert.deepEqual(inject, ['sessionTitle', 'llm', 'tools'])
  assert.equal(typeof captured.listeners['session/event'], 'function')
  assert.equal(captured.tool.name, 'session_title_admin')
})

test('names a root session once its first turn closes, rebuilding the canonical title', async () => {
  const result = await runAuto({ reply: `{"title":"1002${SEP}修复${SEP}登录报错处理"}` })
  assert.equal(result.renamed, true)
  assert.equal(result.title, `1002${SEP}修复${SEP}登录报错处理`)
  // The auxiliary call is marked so no title path can re-trigger itself.
  assert.equal(result.captured.request.purpose, 'session-title')
  assert.equal(result.captured.request.sessionId, 'session-test')
})

test('date comes from createdAt in Asia/Shanghai, across the UTC day boundary', async () => {
  // 2026-09-30T16:30Z is 2026-10-01 00:30 in Asia/Shanghai.
  const createdAt = Date.UTC(2026, 8, 30, 16, 30, 0)
  const rejected = await runAuto({ reply: `{"title":"0930${SEP}修复${SEP}登录报错处理"}` }, { createdAt })
  assert.equal(rejected.renamed, false)
  const accepted = await runAuto({ reply: `{"title":"1001${SEP}修复${SEP}登录报错处理"}` }, { createdAt })
  assert.equal(accepted.renamed, true)
  assert.equal(accepted.title, `1001${SEP}修复${SEP}登录报错处理`)
})

test('rejects an illegal type, a half-width separator, and a missing separator', async () => {
  for (const reply of [
    `{"title":"1002${SEP}重构${SEP}登录报错处理"}`,
    `{"title":"1002|修复|登录报错处理"}`,
    `{"title":"1002${SEP}登录报错处理"}`,
  ]) {
    const result = await runAuto({ reply })
    assert.equal(result.renamed, false, `expected rejection for ${reply}`)
  }
})

test('rejects an empty topic, an over-long topic, and a repeated project name', async () => {
  for (const reply of [
    `{"title":"1002${SEP}修复${SEP}   "}`,
    `{"title":"1002${SEP}修复${SEP}${'很长的主题'.repeat(8)}"}`,
    `{"title":"1002${SEP}修复${SEP}demo 项目登录报错处理"}`,
  ]) {
    const result = await runAuto({ reply })
    assert.equal(result.renamed, false, `expected rejection for ${reply}`)
  }
})

test('rejects Markdown, extra fields, non-JSON prose, and a declined title', async () => {
  for (const reply of [
    '```json\n{"title":"1002' + SEP + '修复' + SEP + '登录报错处理"}\n```',
    `{"title":"1002${SEP}修复${SEP}登录报错处理","reason":"x"}`,
    `标题是：1002${SEP}修复${SEP}登录报错处理`,
    '{"title":null}',
    '',
  ]) {
    const result = await runAuto({ reply })
    assert.equal(result.renamed, false, `expected rejection for ${JSON.stringify(reply)}`)
  }
})

test('accepts complete JSON from a max-tokens finish, rejects a truncated one', async () => {
  // A reasoning route can exhaust the output budget before the model stops; the
  // text it did emit is still usable when it parses and validates.
  const complete = await runAuto({
    reply: `{"title":"1002${SEP}文档${SEP}预算耗尽但完整"}`,
    finish: 'max-tokens',
  })
  assert.equal(complete.renamed, true)
  assert.equal(complete.title, `1002${SEP}文档${SEP}预算耗尽但完整`)
  const truncated = await runAuto({ reply: `{"title":"1002${SEP}文档${SEP}被截断`, finish: 'max-tokens' })
  assert.equal(truncated.renamed, false)
  // A terminal reason that is not "stop" or "max-tokens" stays a failure.
  const errored = await runAuto({ reply: `{"title":"1002${SEP}文档${SEP}报错"}` , finish: 'error' })
  assert.equal(errored.renamed, false)
})

test('skips a title the human already chose, but replaces another provider\'s plain text', async () => {
  const created = Date.UTC(2026, 9, 2, 1, 0, 0)
  const withTitle = (title, source) =>
    fakeSession({ createdAt: created, log: buildLog(FIRST_TURN, { title: { title, source } }) })
  const chosen = await runAuto({}, { session: withTitle('既有标题', { kind: 'user' }) })
  assert.equal(chosen.renamed, false)
  assert.equal(chosen.captured.request, undefined)
  // The stock first-prompt provider writes plain text while the turn runs; that
  // is not a reason to keep a non-compliant title.
  const stock = await runAuto({}, { session: withTitle('PowerShell 含义说明', { kind: 'provider' }) })
  assert.equal(stock.renamed, true)
  const compliant = await runAuto(
    {},
    { session: withTitle(`1002${SEP}修复${SEP}已合规标题`, { kind: 'provider' }) },
  )
  assert.equal(compliant.renamed, false)
  const fallback = await runAuto({}, { session: withTitle('请修复登录报错', { kind: 'fallback' }) })
  assert.equal(fallback.renamed, true)
})

test('names an interrupted first turn from the whole conversation, skips one with no work', async () => {
  // A crash or an interrupt leaves turn 1 without a "completed" end; the session
  // must still be nameable, from whatever the conversation actually holds.
  const aborted = await runAuto(
    {},
    {
      session: fakeSession({
        createdAt: Date.UTC(2026, 9, 2, 1, 0, 0),
        log: buildLog([{ prompt: '改一下', assistant: '已完成的部分结论', end: 'aborted' }]),
      }),
    },
  )
  assert.equal(aborted.renamed, true)
  assert.match(aborted.captured.request.messages[0].content[0].text, /whole_conversation/)
  const empty = await runAuto(
    {},
    { session: fakeSession({ createdAt: Date.UTC(2026, 9, 2, 1, 0, 0), log: buildLog([{ prompt: '改一下' }]) }) },
  )
  assert.equal(empty.renamed, false)
})

test('names at a later turn end when the first turn never closed', async () => {
  const log = buildLog([
    // `end: 'open'` is exactly how a log killed mid-turn looks after a restart.
    { prompt: '先说需求', assistant: '部分进展', end: 'open' },
    { prompt: '继续', assistant: '最终交付：改完并验证通过', tools: ['pwsh'] },
  ])
  const result = await runAuto(
    { reply: `{"title":"1002${SEP}修复${SEP}崩溃后继续完成"}` },
    { session: fakeSession({ createdAt: Date.UTC(2026, 9, 2, 1, 0, 0), log }), triggerTurn: 2 },
  )
  assert.equal(result.renamed, true)
  assert.equal(result.title, `1002${SEP}修复${SEP}崩溃后继续完成`)
  assert.match(result.captured.request.messages[0].content[0].text, /whole_conversation/)
})

test('catch-up sweep names a recent session whose first turn never closed', async () => {
  const createdAt = Date.now() - 60 * 60 * 1000
  const mmdd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(createdAt))
    .replace('-', '')
  const header = { id: 'session-crash', createdAt, cwd: 'C:\\Users\\demo' }
  const log = buildLog([{ prompt: '崩在半路', assistant: '已完成的部分结论', end: 'open' }])
  const writes = []
  const query = {
    listSessions: async () => [{ header, live: false, persisted: true }],
    readTitleSnapshots: async () => [
      { sessionId: 'session-crash', status: 'fulfilled', value: { session: header, title: undefined } },
    ],
    readSession: async () => ({ session: header, events: log }),
  }
  const { ctx, captured } = fakeContext({
    query,
    reply: `{"title":"${mmdd}${SEP}诊断${SEP}崩溃中断补偿命名"}`,
    controller: {
      rename: async (request) => {
        writes.push(request)
        return { title: request.title, seq: 3 }
      },
    },
  })
  apply(ctx)
  await sleep(60)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].title, `${mmdd}${SEP}诊断${SEP}崩溃中断补偿命名`)
  const listed = await captured.tool.execute({ action: 'list' })
  assert.ok(
    listed.auto.recent.some((entry) => entry.outcome === 'sweep' && /named 1/.test(entry.detail)),
    'the sweep must report what it named',
  )
})

test('admin tool: list reports automatic outcomes, apply keeps the date rule and the write path', async () => {
  const header = { id: 'session-a', createdAt: Date.UTC(2026, 8, 20, 1, 0, 0), cwd: 'D:\\__CODE__\\demo' }
  const cold = { id: 'session-b', createdAt: Date.UTC(2026, 8, 21, 1, 0, 0), cwd: 'D:\\__CODE__\\demo' }
  const live_session = { id: 'session-a', header, snapshotEvents: () => [] }
  const renamed = []
  const query = {
    listSessions: async () => [
      { header, live: true, persisted: true },
      { header: cold, live: false, persisted: true },
    ],
    readTitleSnapshots: async (ids) =>
      ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { session: header, title: undefined } })),
    readSurface: async () => ({ events: [] }),
    readTitle: async () => ({ title: '既有标题', source: { kind: 'fallback' } }),
    readTitleSnapshot: async (id) => ({ session: id === 'session-a' ? header : cold }),
    readSession: async (id) => ({ session: id === 'session-a' ? header : cold, events: buildLog(FIRST_TURN) }),
  }
  const { ctx, captured } = fakeContext({
    sessions: [live_session],
    query,
    controller: {
      rename: async (request) => {
        renamed.push(request)
        return { title: request.title, seq: 9 }
      },
    },
  })
  apply(ctx)
  const tool = captured.tool

  const listed = await tool.execute({ action: 'list' })
  assert.equal(listed.count, 2)
  assert.equal(listed.auto.trigger, 'session/event turn/end (any turn)')
  assert.equal(typeof listed.auto.catch_up.window_ms, 'number')
  // Newest first: the cold 0921 session precedes the live 0920 one.
  assert.equal(listed.items[0].mmdd, '0921')
  assert.equal(listed.items[1].mmdd, '0920')

  const inspected = await tool.execute({ action: 'inspect', session_id: 'session-a' })
  assert.equal(inspected.mmdd, '0920')
  assert.equal(inspected.first_turn_end, 'completed')

  const applied = await tool.execute({
    action: 'apply',
    titles: [
      { session_id: 'session-a', title: `0920${SEP}修复${SEP}登录报错处理` },
      { session_id: 'session-b', title: `0921${SEP}诊断${SEP}登录报错定位` },
      { session_id: 'session-b', title: `0920${SEP}修复${SEP}日期错配` },
      { session_id: 'session-b', title: `0921${SEP}重构${SEP}类型非法` },
    ],
  })
  assert.equal(applied.applied_count, 2)
  assert.equal(applied.failed_count, 2)
  assert.equal(applied.applied[0].via, 'sessionTitle.rename')
  assert.equal(applied.applied[1].via, 'sessionController.rename')
  assert.equal(renamed.length, 1)
  assert.match(applied.failed[0].reason, /MMDD=0921/)
  assert.match(applied.failed[1].reason, /MMDD=0921/)
})

test('admin tool: summarize names a specified conversation from its whole content', async () => {
  const header = { id: 'session-c', createdAt: Date.UTC(2026, 8, 24, 5, 49, 27), cwd: 'C:\\Users\\demo' }
  const log = buildLog([
    { prompt: '第一个问题', assistant: '第一轮结论', tools: ['pwsh'] },
    { prompt: '继续', assistant: '第二轮结论', tools: ['read', 'pwsh'] },
    { prompt: '最后收尾', assistant: '最终交付：改了配置并验证通过', tools: ['edit'] },
  ])
  const writes = []
  const query = {
    readSession: async () => ({ session: header, events: log }),
    readTitleSnapshot: async () => ({ session: header }),
  }
  const { ctx, captured } = fakeContext({ query, reply: `{"title":"0924${SEP}修复${SEP}配置改动与验证"}` })
  apply(ctx)
  const tool = captured.tool
  // A cold session has no live store entry, so the write goes through the controller.
  ctx.get = (key) =>
    key === 'sessionQuery'
      ? query
      : key === 'sessionController'
        ? {
            rename: async (request) => {
              writes.push(request)
              return { title: request.title, seq: 7 }
            },
          }
        : undefined

  const preview = await tool.execute({ action: 'summarize', session_id: 'session-c', dry_run: true })
  assert.equal(preview.title, `0924${SEP}修复${SEP}配置改动与验证`)
  assert.equal(preview.written, false)
  assert.equal(preview.turn_count, 3)
  assert.equal(writes.length, 0)
  // The whole conversation reached the model, not just the first turn.
  assert.match(captured.request.messages[0].content[0].text, /whole_conversation/)
  assert.match(captured.request.messages[0].content[0].text, /最终交付/)

  const written = await tool.execute({ action: 'summarize', session_id: 'session-c' })
  assert.equal(written.written, true)
  assert.equal(written.via, 'sessionController.rename')
  assert.equal(writes.length, 1)
  assert.equal(writes[0].title, `0924${SEP}修复${SEP}配置改动与验证`)
})

test('admin tool: summarize refuses a title whose date is not the session createdAt', async () => {
  const header = { id: 'session-d', createdAt: Date.UTC(2026, 8, 24, 5, 49, 27), cwd: 'C:\\Users\\demo' }
  const query = {
    readSession: async () => ({ session: header, events: buildLog(FIRST_TURN) }),
    readTitleSnapshot: async () => ({ session: header }),
  }
  const writes = []
  const { ctx, captured } = fakeContext({ query, reply: `{"title":"0101${SEP}修复${SEP}错误日期"}` })
  apply(ctx)
  ctx.get = (key) =>
    key === 'sessionQuery'
      ? query
      : key === 'sessionController'
        ? {
            rename: async (request) => {
              writes.push(request)
              return { title: request.title, seq: 1 }
            },
          }
        : undefined
  await assert.rejects(
    captured.tool.execute({ action: 'summarize', session_id: 'session-d' }),
    /does not match createdAt-derived 0924/,
  )
  assert.equal(writes.length, 0)
})
