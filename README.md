# @chi-hong22/dsh-session-autoname

DeepSeek Harness host plugin: name a new conversation once, on its first turn, as
`MMDD｜类型｜主题` — the DSH port of a Codex `Stop`-hook renaming setup. It also
names any specified conversation on demand by summarizing its whole content.

Installs as a profile bundle — from GitHub, or from the out-of-tree working copy at
`D:\__CODE__\_tookit\261002_dsh-session-autoname`:

```powershell
dsh plugin --profile <profile> add github:Chi-hong22/dsh-session-autoname
# local development:
dsh plugin --profile desktop add "D:/__CODE__/_tookit/261002_dsh-session-autoname"
# or through the harness: plugin_manager install_bundle link:D:/__CODE__/_tookit/261002_dsh-session-autoname
```

## Responsibilities

### 1. Automatic first-turn naming

- Trigger: the durable `turn/end` event of turn 1 on a root session
  (`session/event`). No `hooks.json`, no `Stop` handler, and **no title provider
  registration** — see below.
- Evidence: the user request plus the work the assistant actually completed in
  that turn (final text, tool calls), folded from the session log.
- Date: `MMDD` from the session's own `header.createdAt` in `Asia/Shanghai`
  (never `updatedAt`, never the host clock).
- Write: `ctx.sessionTitle.rename()`, the interface the GUI itself uses.
- Skip conditions: not a root session; the turn did not end `completed`; no
  assistant text; the human already renamed the session; the title is already
  compliant. Every failure keeps the title already on the session, and the reason
  is recorded in the admin tool's `auto.recent` ring.

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
node --test tests/provider.test.mjs      # offline: rules, rejections, trigger skips, admin tool
node tools/history-evidence.mjs 0        # read-only first-turn digests of root sessions
```

Then on a live host: `session_title_admin {"action":"selftest"}` for the automatic
path, and `{"action":"list"}` to read the recent automatic outcomes.

## Known limits

- Automatic naming cannot run "before the answer is delivered": DSH streams the
  answer to the browser while the turn runs. The title lands as soon as the first
  turn closes, without delaying it.
- A first turn that ends `aborted`, `interrupted`, `error`, or `max-tokens` is not
  auto-named, because its work is not a completed result. Use `summarize`.
- `sessionController.rename` resumes a cold session, so naming one whose recorded
  `agentPreset` no longer exists fails with `Unknown agent preset`.
- `D:\__CODE__` is inside a file-sync scope on this machine, so in-place edits can
  briefly fail with a Windows sharing violation; retry.
