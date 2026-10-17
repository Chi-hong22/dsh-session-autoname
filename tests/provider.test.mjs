/**
 * Offline verification of the plugin's own logic, driven through the real
 * `apply()` surface with a fake Cordis context: no host, no model, no network.
 *
 *   node --test tests/provider.test.mjs
 *
 * The plugin now owns the single session-title provider slot, so the tests drive
 * `provider.generate()` exactly as the official service does and check the
 * provider contract (a valid title plus `messageSeqs`), the acceptance rules the
 * hook port must enforce (date from createdAt in Asia/Shanghai, the ten types,
 * full-width separator, topic budget, strict JSON, project-name exclusion), the
 * deterministic placeholder used when no model title is available, the one-shot
 * correction of that placeholder, the conflict behaviour, and the admin tool.
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
/** The placeholder a session gets before its first turn has produced anything. */
const PLACEHOLDER = `1002${SEP}探索${SEP}请修复登录报错`

/** Asia/Shanghai MMDD of one timestamp, derived the way the plugin derives it. */
function mmddOf(timestamp) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' })
    .format(new Date(timestamp))
    .replace('-', '')
}

/** Build one live-session stand-in backed by a fixed event log. */
function fakeSession({ id = 'session-test', createdAt, cwd = 'D:\\__CODE__\\demo', log = buildLog(FIRST_TURN), header } = {}) {
  return {
    id,
    header: header ?? { id, createdAt, cwd },
    snapshotEvents: () => log,
  }
}

/**
 * Build the fake host context.
 * @param reply - the raw text the fake model streams back.
 * @param conflict - when set, `register` throws with this message.
 */
function fakeContext({
  reply = `{"title":"1002${SEP}功能${SEP}演示主题"}`,
  finish = 'stop',
  sessions = [],
  query,
  controller,
  conflict,
  failStream = false,
  timer = { timeout: (callback) => { queueMicrotask(callback); return () => {} } },
} = {}) {
  const captured = { renames: [], refreshes: [], listeners: {} }
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
      register: (provider) => {
        if (conflict !== undefined) throw new Error(conflict)
        captured.provider = provider
        return () => {}
      },
      refresh: async (session) => {
        captured.refreshes.push(session)
        return { title: 'refreshed', eventSeq: 2 }
      },
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
          for (const chunk of chunks) {
            if (failStream) throw new Error('stream failed')
            yield chunk
          }
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
 * Drive one provider generation and report what it returned.
 * @param overrides.messages - the eligible human messages the service passes in.
 */
async function runAuto(options, overrides = {}) {
  const session =
    overrides.session ?? fakeSession({ createdAt: overrides.createdAt ?? Date.UTC(2026, 9, 2, 1, 0, 0) })
  const { ctx, captured } = fakeContext({ ...options, sessions: [session] })
  apply(ctx)
  const messages = overrides.messages ?? [{ seq: 3, text: '请修复登录报错' }]
  const result = await captured.provider.generate({
    session,
    messages,
    route: { provider: 'p', model: 'm' },
    signal: overrides.signal ?? new AbortController().signal,
  })
  return { result, title: result.title, captured, ctx, session }
}

test('plugin surface: name, inject, the provider slot, and one admin tool', () => {
  const { ctx, captured } = fakeContext({})
  apply(ctx)
  assert.equal(name, 'dsh-session-autoname')
  assert.deepEqual(inject, ['sessionTitle', 'llm', 'tools'])
  assert.equal(captured.provider.id, 'session-autoname')
  assert.equal(captured.provider.automatic, 'all-prompts')
  assert.equal(typeof captured.provider.generate, 'function')
  assert.equal(typeof captured.listeners['session/event'], 'function')
  assert.equal(captured.tool.name, 'session_title_admin')
})

test('a taken provider slot refuses to activate instead of idling', () => {
  // A row that shows "running" but never writes a title is exactly the silent
  // no-op the plugin must not create; a failed entry is visible on the plugin page.
  const { ctx } = fakeContext({ conflict: 'session-title provider "x" is already registered' })
  assert.throws(() => apply(ctx), /already taken[\s\S]*exactly ONE/)
})

test('names a root session from its completed work, rebuilding the canonical title', async () => {
  const { title, result, captured } = await runAuto({ reply: `{"title":"1002${SEP}修复${SEP}登录报错处理"}` })
  assert.equal(title, `1002${SEP}修复${SEP}登录报错处理`)
  // The provider contract: a title plus the seqs of the messages it was built from.
  assert.deepEqual(result.messageSeqs, [3])
  assert.deepEqual(result.model, { provider: 'p', model: 'm' })
  // The auxiliary call is marked so no title path can re-trigger itself.
  assert.equal(captured.request.purpose, 'session-title')
  assert.equal(captured.request.sessionId, 'session-test')
})

test('date comes from createdAt in Asia/Shanghai, across the UTC day boundary', async () => {
  // 2026-09-30T16:30Z is 2026-10-01 00:30 in Asia/Shanghai.
  const createdAt = Date.UTC(2026, 8, 30, 16, 30, 0)
  const rejected = await runAuto({ reply: `{"title":"0930${SEP}修复${SEP}登录报错处理"}` }, { createdAt })
  assert.equal(rejected.title, `1001${SEP}探索${SEP}请修复登录报错`)
  const accepted = await runAuto({ reply: `{"title":"1001${SEP}修复${SEP}登录报错处理"}` }, { createdAt })
  assert.equal(accepted.title, `1001${SEP}修复${SEP}登录报错处理`)
})

test('falls back on an illegal type, a half-width separator, and a missing separator', async () => {
  for (const reply of [
    `{"title":"1002${SEP}重构${SEP}登录报错处理"}`,
    `{"title":"1002|修复|登录报错处理"}`,
    `{"title":"1002${SEP}登录报错处理"}`,
  ]) {
    const { title } = await runAuto({ reply })
    assert.equal(title, PLACEHOLDER, `expected the placeholder for ${reply}`)
  }
})

test('falls back on an empty topic, an over-long topic, and a repeated project name', async () => {
  for (const reply of [
    `{"title":"1002${SEP}修复${SEP}   "}`,
    `{"title":"1002${SEP}修复${SEP}${'很长的主题'.repeat(8)}"}`,
    `{"title":"1002${SEP}修复${SEP}demo 项目登录报错处理"}`,
  ]) {
    const { title } = await runAuto({ reply })
    assert.equal(title, PLACEHOLDER, `expected the placeholder for ${reply}`)
  }
})

test('falls back on Markdown, extra fields, non-JSON prose, and a declined title', async () => {
  for (const reply of [
    '```json\n{"title":"1002' + SEP + '修复' + SEP + '登录报错处理"}\n```',
    `{"title":"1002${SEP}修复${SEP}登录报错处理","reason":"x"}`,
    `标题是：1002${SEP}修复${SEP}登录报错处理`,
    '{"title":null}',
    '',
  ]) {
    const { title } = await runAuto({ reply })
    assert.equal(title, PLACEHOLDER, `expected the placeholder for ${JSON.stringify(reply)}`)
  }
})

test('accepts complete JSON from a max-tokens finish, falls back on a truncated one', async () => {
  // A reasoning route can exhaust the output budget before the model stops; the
  // text it did emit is still usable when it parses and validates.
  const complete = await runAuto({
    reply: `{"title":"1002${SEP}文档${SEP}预算耗尽但完整"}`,
    finish: 'max-tokens',
  })
  assert.equal(complete.title, `1002${SEP}文档${SEP}预算耗尽但完整`)
  const truncated = await runAuto({ reply: `{"title":"1002${SEP}文档${SEP}被截断`, finish: 'max-tokens' })
  assert.equal(truncated.title, PLACEHOLDER)
  // A terminal reason that is not "stop" or "max-tokens" stays a failure.
  const errored = await runAuto({ reply: `{"title":"1002${SEP}文档${SEP}报错"}`, finish: 'error' })
  assert.equal(errored.title, PLACEHOLDER)
})

test('names an interrupted first turn from the whole conversation', async () => {
  // A crash or an interrupt leaves turn 1 without a "completed" end; the session
  // must still be nameable, from whatever the conversation actually holds.
  const { title, captured } = await runAuto(
    {},
    {
      session: fakeSession({
        createdAt: Date.UTC(2026, 9, 2, 1, 0, 0),
        log: buildLog([{ prompt: '改一下', assistant: '已完成的部分结论', end: 'aborted' }]),
      }),
    },
  )
  assert.equal(title, `1002${SEP}功能${SEP}演示主题`)
  assert.match(captured.request.messages[0].content[0].text, /whole_conversation/)
})

test('a turn with no assistant work yet becomes a placeholder and asks for a correction', async () => {
  const { title, captured, ctx, session } = await runAuto(
    {},
    {
      session: fakeSession({
        // A dedicated id: the placeholder marks this session as pending, and that
        // in-memory mark would leak into the sessions other tests name.
        id: 'session-first-placeholder',
        createdAt: Date.UTC(2026, 9, 2, 1, 0, 0),
        log: buildLog([{ prompt: '请修复登录报错', end: 'open' }]),
      }),
    },
  )
  assert.equal(title, PLACEHOLDER)
  assert.equal(captured.request, undefined, 'no model call without evidence to classify')
  // The provider is called again through the service once the turn produced work.
  captured.listeners['session/event'](session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    seq: 999,
  })
  await sleep(10)
  assert.equal(captured.refreshes.length, 1)
  assert.equal(captured.renames.length, 0, 'a refresh keeps the title a provider title')
})

test('the correction is not anchored on the placeholder this plugin wrote itself', async () => {
  const createdAt = Date.UTC(2026, 9, 2, 1, 0, 0)
  const empty = fakeSession({
    id: 'session-anchor',
    createdAt,
    log: buildLog([{ prompt: '请修复登录报错', end: 'open' }]),
  })
  const first = await runAuto({}, { session: empty })
  assert.equal(first.title, PLACEHOLDER)
  // Same session with the placeholder as its title: the model must not be told the
  // placeholder describes the task, or the correction would return it verbatim.
  const log = buildLog(FIRST_TURN, { title: { title: PLACEHOLDER, source: { kind: 'provider' } } })
  const { title, captured } = await runAuto(
    { reply: `{"title":"1002${SEP}修复${SEP}登录报错处理"}` },
    { session: fakeSession({ id: 'session-anchor', createdAt, log }) },
  )
  assert.equal(title, `1002${SEP}修复${SEP}登录报错处理`)
  assert.match(captured.request.messages[0].content[0].text, /"current_title":null/)
})

test('a genuine 探索 title is still anchored; only the derived placeholder is not', async () => {
  const createdAt = Date.UTC(2026, 9, 2, 1, 0, 0)
  const log = buildLog(FIRST_TURN, {
    title: { title: `1002${SEP}探索${SEP}排查登录链路`, source: { kind: 'provider' } },
  })
  const { captured } = await runAuto(
    { reply: `{"title":"1002${SEP}探索${SEP}排查登录链路"}` },
    { session: fakeSession({ id: 'session-anchor-real', createdAt, log }) },
  )
  assert.match(
    captured.request.messages[0].content[0].text,
    /"current_title":"1002｜探索｜排查登录链路"/,
  )
})

test('a later turn reads the whole conversation and carries the current title', async () => {
  const turns = [
    { prompt: '先说需求', assistant: '部分进展', end: 'open' },
    { prompt: '继续', assistant: '最终交付：改完并验证通过', tools: ['pwsh'] },
  ]
  const log = buildLog(turns)
  const withTitle = buildLog(turns, {
    title: { title: `1002${SEP}修复${SEP}崩溃后继续完成`, source: { kind: 'provider' } },
  })
  const { title, captured } = await runAuto(
    { reply: `{"title":"1002${SEP}修复${SEP}崩溃后继续完成"}` },
    { session: fakeSession({ createdAt: Date.UTC(2026, 9, 2, 1, 0, 0), log: withTitle }) },
  )
  assert.equal(title, `1002${SEP}修复${SEP}崩溃后继续完成`)
  const framed = captured.request.messages[0].content[0].text
  assert.match(framed, /whole_conversation/)
  assert.match(framed, /最终交付/)
  assert.match(framed, /崩溃后继续完成/)
  // A log of the same shape without a title is still namable.
  const plain = await runAuto(
    { reply: `{"title":"1002${SEP}修复${SEP}崩溃后继续完成"}` },
    { session: fakeSession({ createdAt: Date.UTC(2026, 9, 2, 1, 0, 0), log }) },
  )
  assert.equal(plain.title, `1002${SEP}修复${SEP}崩溃后继续完成`)
})

test('a title generated from evidence is not corrected again at the turn end', async () => {
  // The correction exists only for the placeholder; a real title must not cost a
  // second model call at the end of every first turn.
  const session = fakeSession({ id: 'session-clean', createdAt: Date.UTC(2026, 9, 2, 1, 0, 0) })
  const { captured, title } = await runAuto({}, { session })
  assert.equal(title, `1002${SEP}功能${SEP}演示主题`)
  captured.listeners['session/event'](session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    seq: 999,
  })
  await sleep(10)
  assert.equal(captured.refreshes.length, 0)
})

test('the placeholder is never overwritten once the human pinned the title', async () => {
  const log = buildLog(
    [{ prompt: '请修复登录报错', end: 'open' }],
    { title: { title: '我的手写标题', source: { kind: 'user' } } },
  )
  const { captured, session } = await runAuto(
    {},
    { session: fakeSession({ createdAt: Date.UTC(2026, 9, 2, 1, 0, 0), log }) },
  )
  captured.listeners['session/event'](session, {
    type: 'turn/end',
    data: { turn: 1, reason: { kind: 'completed' } },
    seq: 999,
  })
  await sleep(10)
  assert.equal(captured.refreshes.length, 0, 'a user rename pins the title')
})

test('a subagent session gets a deterministic placeholder without a model call', async () => {
  const session = fakeSession({
    createdAt: Date.UTC(2026, 9, 2, 1, 0, 0),
    header: { id: 'session-test', createdAt: Date.UTC(2026, 9, 2, 1, 0, 0), cwd: 'D:\\x', parentSession: 'root' },
  })
  const { title, captured, result } = await runAuto({}, { session })
  assert.equal(title, PLACEHOLDER)
  assert.deepEqual(result.messageSeqs, [3])
  assert.equal(captured.request, undefined)
})

test('an aborted generation rethrows so the service records nothing', async () => {
  // The service silences an aborted generation; swallowing the abort here would
  // instead write a placeholder over a title that is about to be regenerated.
  const session = fakeSession({ createdAt: Date.UTC(2026, 9, 2, 1, 0, 0) })
  const { ctx, captured } = fakeContext({ failStream: true })
  apply(ctx)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    captured.provider.generate({ session, messages: [{ seq: 1, text: 'x' }], signal: aborted.signal }),
    /stream failed/,
  )
})

test('catch-up sweep refreshes a recent session the schedule cannot reach', async () => {
  const createdAt = Date.now() - 60 * 60 * 1000
  const mmdd = mmddOf(createdAt)
  const header = { id: 'session-crash', createdAt, cwd: 'C:\\Users\\demo' }
  const log = buildLog([{ prompt: '崩在半路', assistant: '已完成的部分结论', end: 'open' }])
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
      resolveAgent: async () => ({ agent: { session: { id: 'session-crash', header } } }),
      rename: async (request) => {
        throw new Error(`the sweep must refresh, not rename (${request.title})`)
      },
    },
  })
  apply(ctx)
  await sleep(60)
  const listed = await captured.tool.execute({ action: 'list' })
  assert.equal(captured.refreshes.length, 1)
  assert.equal(captured.renames.length, 0, 'a refresh keeps the title a provider title')
  assert.ok(
    listed.auto.recent.some((entry) => entry.outcome === 'sweep' && /refreshed 1/.test(entry.detail)),
    'the sweep must report what it refreshed',
  )
})

test('catch-up sweep replaces a placeholder whose turn completed while the host was down', async () => {
  // The placeholder is compliant, so a compliance-only filter would skip it and the
  // session would keep the opening sentence as its title forever.
  const createdAt = Date.now() - 60 * 60 * 1000
  const mmdd = mmddOf(createdAt)
  const header = { id: 'session-stuck', createdAt, cwd: 'C:\\Users\\demo' }
  const log = buildLog(FIRST_TURN, {
    title: { title: `${mmdd}${SEP}探索${SEP}请修复登录报错`, source: { kind: 'provider' } },
  })
  const current = log.at(-1).data
  const query = {
    listSessions: async () => [{ header, live: false, persisted: true }],
    readTitleSnapshots: async () => [
      { sessionId: 'session-stuck', status: 'fulfilled', value: { session: header, title: current } },
    ],
    readSession: async () => ({ session: header, events: log }),
  }
  const { ctx, captured } = fakeContext({
    query,
    reply: `{"title":"${mmdd}${SEP}修复${SEP}登录报错处理"}`,
    controller: { resolveAgent: async () => ({ agent: { session: { id: 'session-stuck', header } } }) },
  })
  apply(ctx)
  await sleep(60)
  assert.equal(captured.refreshes.length, 1)
})

test('catch-up sweep leaves a placeholder alone until the turn has work to classify', async () => {
  const createdAt = Date.now() - 60 * 60 * 1000
  const mmdd = mmddOf(createdAt)
  const header = { id: 'session-open', createdAt, cwd: 'C:\\Users\\demo' }
  const log = buildLog([{ prompt: '崩在半路', end: 'open' }], {
    title: { title: `${mmdd}${SEP}探索${SEP}崩在半路`, source: { kind: 'provider' } },
  })
  const current = log.at(-1).data
  const query = {
    listSessions: async () => [{ header, live: false, persisted: true }],
    readTitleSnapshots: async () => [
      { sessionId: 'session-open', status: 'fulfilled', value: { session: header, title: current } },
    ],
    readSession: async () => ({ session: header, events: log }),
  }
  const { ctx, captured } = fakeContext({
    query,
    reply: `{"title":"${mmdd}${SEP}修复${SEP}崩在半路的排查"}`,
    controller: { resolveAgent: async () => ({ agent: { session: { id: 'session-open', header } } }) },
  })
  apply(ctx)
  await sleep(60)
  assert.equal(captured.refreshes.length, 0)
})

test('admin tool: list reports the provider, apply keeps the date rule and the write path', async () => {
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
    timer: null,
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
  assert.deepEqual(listed.auto.provider, { id: 'session-autoname', automatic: 'all-prompts' })
  assert.match(listed.auto.trigger, /official schedule/)
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
  const { ctx, captured } = fakeContext({ query, timer: null, reply: `{"title":"0924${SEP}修复${SEP}配置改动与验证"}` })
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
  const { ctx, captured } = fakeContext({ query, timer: null, reply: `{"title":"0101${SEP}修复${SEP}错误日期"}` })
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
