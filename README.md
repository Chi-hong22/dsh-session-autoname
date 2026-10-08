# @chi-hong22/dsh-session-autoname

DeepSeek Harness host plugin: name a new conversation once, at its first naming
opportunity, as `MMDD｜类型｜主题` — the DSH port of a Codex `Stop`-hook renaming
setup. It also names any specified conversation on demand by summarizing its whole
content, and it catches up on sessions that were never named because the host died
mid-turn.

Installs as a profile bundle — from GitHub, or from the out-of-tree working copy at
`D:\__CODE__\_tookit\261002_dsh-session-autoname`:

```powershell
dsh plugin --profile <profile> add github:Chi-hong22/dsh-session-autoname
# local development:
dsh plugin --profile desktop add "D:/__CODE__/_tookit/261002_dsh-session-autoname"
# or through the harness: plugin_manager install_bundle link:D:/__CODE__/_tookit/261002_dsh-session-autoname
```

## Responsibilities

### 1. Automatic naming

- Trigger: the durable `turn/end` event of ANY turn on a root session
  (`session/event`) — normally turn 1, but also a later turn when the first one was
  lost. No `hooks.json`, no `Stop` handler, and **no title provider
  registration** — see below.
- Evidence: turn 1's own completed result when it has one (the user request plus
  the work that turn actually delivered, folded from the session log); otherwise
  the whole conversation so far, which is what keeps a session whose first turn was
  interrupted or killed still nameable.
- Date: `MMDD` from the session's own `header.createdAt` in `Asia/Shanghai`
  (never `updatedAt`, never the host clock).
- Write: `ctx.sessionTitle.rename()`, the interface the GUI itself uses.
- Skip conditions: not a root session; no assistant text anywhere; the human
  already renamed the session; the title is already compliant. Every failure keeps
  the title already on the session, and the reason is recorded in the admin tool's
  `auto.recent` ring.
- Exactly once: a compliant title, or a user-chosen one, ends the attempts, so
  later turns do nothing.

Accepted output is rebuilt from validated parts and must be exactly
`MMDD｜类型｜主题`: the date must equal the `createdAt`-derived value, the type must
be one of 功能/设计/修复/优化/发布/探索/文档/研究/诊断/验证, the separator must be
full-width `｜`, and the topic must be non-empty, within 24 characters and 60
bytes, free of control characters, and free of the project name. Markdown, code
fences, prose, extra JSON fields, `{"title":null}`, and over-long titles are all
rejected rather than guessed. A model call that ends `max-tokens` is still
accepted when the text it emitted parses and validates — a reasoning route can
exhaust its budget before stopping.

### 2. Naming a specified conversation

`session_title_admin` with `{"action":"summarize","session_id":"…"}` reads the
WHOLE conversation — its opening intent plus the per-turn outcomes that fit a
byte budget, biased to the end where the result lives — and writes one
`MMDD｜类型｜主题` title for it. `dry_run:true` previews without writing. Live
sessions are written through `sessionTitle.rename`; cold ones through
`sessionController.rename`. The same date and type rules apply.

Other actions: `list` (recent root sessions, their titles, and recent automatic
outcomes), `inspect` (one session's first-turn evidence), `apply` (exact renames,
each re-validated against that session's own `createdAt`), `archive` (hide
throwaway test sessions), `selftest` (create a throwaway session and prove real
first-turn auto-naming end to end).

### 3. Catch-up sweep after a crash or restart

The trigger above is a live event, so a host that dies mid-turn never delivers the
`turn/end` that would have named the session — and after the restart that turn is
restored as an open turn that can never end as `completed`. Five seconds after this
plugin applies, it therefore names every root session that is **still without a
compliant title** and holds assistant work, inside a bounded window:

| Bound | Value | Why |
|---|---|---|
| window | 48 h of `header.createdAt` | the crash case is minutes old; older sessions are reached when they are continued, or by `summarize` |
| cap | 5 named per start | a start must never become a mass rename of history |
| delay | 5 s | the sweep must not compete with the host's own startup |

Each outcome lands in `auto.recent` (`named` / `skipped` / `failed`, plus one
`sweep` line carrying the counts), so a start can be audited without reading logs.

## Why nothing has to be disabled

`ctx.sessionTitle.register()` accepts exactly ONE provider, and the stock
`@deepseek-ai/dsh-session-title-first-prompt-llm` occupies it. This plugin avoids
the conflict instead of resolving it in configuration:

- It never calls `register()`, so the slot's single-owner rule is irrelevant; the
  official provider stays enabled and untouched.
- `sessionTitle.rename()` calls `supersede()` internally, which aborts that
  provider's in-flight generation and invalidates its pending one, and a
  user-source title pins the session against later automatic revisions.
- Net effect: while the first turn runs, the sidebar shows the stock provider's
  plain-text title as a placeholder; once the turn closes, this plugin replaces it
  with the compliant one.

## Wiring

`cordis.patch.yml` is this bundle's patch layer — one row, no foreign rows:

```yaml
- insert:
    - id: session-autoname
      name: '@chi-hong22/dsh-session-autoname'
```

The row names the package rather than a file URL, so the bundle runs wherever it is
fetched from — `github:Chi-hong22/dsh-session-autoname` included. A bare name is
safe here because an installed copy is immutable: the loader resolves each specifier
once per host process, and that single resolution points at the installed package
for the life of the process.

For local development this profile links the working copy
(`link:D:/__CODE__/_tookit/261002_dsh-session-autoname`), so the same bare name
resolves through the junction to this checkout's `session-naming.js` — checked with
`import.meta.resolve` from the profile directory. Editing the file and restarting
DSH loads the edited code.

> Need the row to be unable to name anything but this checkout (for example when an
> older copy of the package is also reachable from the profile)? Override it in the
> profile's own `cordis.patch.yml`: `- id: session-autoname` with
> `name: 'file:///D:/__CODE__/_tookit/261002_dsh-session-autoname/session-naming.js'`.

## Reloading after a code edit

Restart DSH — it re-imports the resolved file. Without a restart the module URL has
to change, and a package-name row always resolves to the same file: switch to the
file-URL override above, pointed at a renamed copy of the implementation file, so
the loader sees a URL it has not cached.

## Verifying

```powershell
node --test tests/provider.test.mjs      # offline: rules, rejections, trigger skips, catch-up, admin tool
node tools/history-evidence.mjs 0        # read-only first-turn digests of root sessions
```

Then on a live host: `session_title_admin {"action":"selftest"}` for the automatic
path, and `{"action":"list"}` to read the recent automatic outcomes.

## Known limits

- Automatic naming cannot run "before the answer is delivered": DSH streams the
  answer to the browser while the turn runs. The title lands as soon as the first
  turn closes, without delaying it.
- A first turn that ends `aborted`, `interrupted`, `error`, or `max-tokens` is
  named from the whole conversation instead of from that turn's partial result, and
  the model is told to stay conservative about the type. Only a session with no
  assistant work at all is left unnamed — name it later with `summarize`.
- The catch-up sweep is bounded (48 h, 5 per start). A session older than the window
  that was never continued and never named keeps its placeholder until `summarize`
  is asked for it.
- `sessionController.rename` resumes a cold session, so naming one whose recorded
  `agentPreset` no longer exists fails with `Unknown agent preset`.
- `D:\__CODE__` is inside a file-sync scope on this machine, so in-place edits can
  briefly fail with a Windows sharing violation; retry.
