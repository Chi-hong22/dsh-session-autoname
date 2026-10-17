# @chi-hong22/dsh-session-autoname

DeepSeek Harness host plugin: keep every root conversation titled in the strict
`MMDD｜类型｜主题` form, refreshed as the conversation moves — the DSH port of a
Codex `Stop`-hook renaming setup, driven by the harness's own conversation-following
title schedule. It also names any specified conversation on demand by summarizing its
whole content, and it catches up on sessions whose title never became compliant.

Installs as a profile bundle — from GitHub, or from the out-of-tree working copy at
`D:\__CODE__\_tookit\261002_dsh-session-autoname`:

```powershell
dsh plugin --profile <profile> add github:Chi-hong22/dsh-session-autoname
# local development:
dsh plugin --profile desktop add "D:/__CODE__/_tookit/261002_dsh-session-autoname"
# or through the harness: plugin_manager install_bundle link:D:/__CODE__/_tookit/261002_dsh-session-autoname
```

> **Mutually exclusive with the official "随对话更新的标题" plugin
> (`@deepseek-ai/dsh-experimental-session-titles-bundle`). Both claim the one
> session-title provider slot — enable exactly one, never both.** See
> [Choose one](#choose-one-this-plugin-or-the-official-one) and
> [Switching between them](#switching-between-them).

## 中文说明

- **作用**：用严格格式 `MMDD｜类型｜主题` 给根会话命名并随对话更新；也能按需（`summarize`）通读整段对话命名；启动时补扫近期未合规的会话。
- **与官方插件互斥**：两者争抢同一个标题提供方槽位，只能启用其中一个。本插件的补丁会关掉自带的 `session-title-llm`（首条提示提供方）；若官方"随对话更新的标题"同时启用，先加载者拿到槽位，另一个在插件页显示"异常"，不会出现"显示运行却从不写标题"的空转。运行时如果槽位已被占用，本插件直接报错退出注册，绝不 `rename`、绝不钉住标题。
- **怎么切换**：最佳状态是只开本插件；官方插件默认不在 profile 里，不打开就是关闭。要换成官方：先关掉本插件的**整个 bundle**并重启（让出槽位），再打开"随对话更新的标题"并再重启一次；换回来时反向操作。不要只关本插件内部的 `session-autoname` 行而保留 bundle——补丁仍会关着自带提供方，结果是没有任何提供方在工作，标题只剩服务兜底。
- **节奏**：服务每收到一条人类提示调度一次标题请求（`all-prompts`），因此标题会滞后一轮；首轮请求发生在助手产出之前，只能先写占位 `MMDD｜探索｜首句前 12 字`，该轮 `turn/end` 时自动纠正为正式标题。
- **失败处理**：模型失败或返回不合规时，保留合规占位并在 `auto.recent` 记一条 `failed`；调用被中止时什么都不写。
- **边界**：子代理会话不发模型调用，只写确定性占位；日期取会话 `header.createdAt` 的 `Asia/Shanghai` 日期，不用主机时钟。

## How it runs

The title service (`@deepseek-ai/dsh-session-title`) owns scheduling and storage;
this plugin owns the judgement:

1. This bundle's patch disables the stock first-prompt provider
   (`@deepseek-ai/dsh-session-title-first-prompt-llm`, row `session-title-llm`) so
   the single provider slot is free.
2. The plugin registers the slot with `automatic: 'all-prompts'`. The service now
   schedules one title request per human prompt, right before that turn's first main
   request — the same cadence as the official conversation-following plugin.
3. The service validates `messageSeqs`, persists the result as a provider-source
   `session/title`, and the GUI picks it up. Nothing is written through
   `rename()`, so a generated title never pins the session and later turns keep
   the schedule alive.

### 1. Automatic naming

- Evidence: when the turn that triggered the request already has completed
  assistant work, that turn's own result (user request, assistant work, tool calls
  folded from the session log); otherwise the whole conversation so far, which is
  what keeps a session whose first turn was interrupted or killed still nameable.
- First title of a session: the service asks **before** the turn has produced
  anything, so a first generation can only be a placeholder —
  `MMDD｜探索｜<first 12 characters of the opening prompt>`, rebuilt through the same
  validation as a model title. The plugin remembers that session and, at `turn/end`,
  asks the service for one `refresh()` — the same slot, the same provider-source
  write, now with the turn's completed work. A later turn then names from the whole
  conversation.
- Staying stable across turns: the request carries the current title, and the model
  is told to return it verbatim while it still describes the main task. A type or
  topic changes only when the task itself changed — not every turn produces a new
  title. The placeholder is never carried as that anchor, so the correction always
  replaces it instead of being told to keep it.
- Date: `MMDD` from the session's own `header.createdAt` in `Asia/Shanghai`
  (never `updatedAt`, never the host clock).
- Skip conditions: a subagent session (deterministic placeholder, no model call);
  the human already renamed the session (the service stops scheduling, and the
  correction step checks the latest title's source before refreshing); the generated
  title fails validation.
- Failure: the model call being aborted is re-thrown so the service records nothing;
  any other failure keeps a compliant placeholder on the session and records
  `failed` in the admin tool's `auto.recent` ring.

Accepted output is rebuilt from validated parts and must be exactly
`MMDD｜类型｜主题`: the date must equal the `createdAt`-derived value, the type must
be one of 功能/设计/修复/优化/发布/探索/文档/研究/诊断/验证, the separator must be
full-width `｜`, and the topic must be non-empty, within 24 characters and 60
bytes, free of control characters, and free of the project name. Markdown, code
fences, prose, extra JSON fields, `{"title":null}`, and over-long titles are all
rejected rather than guessed; a rejected title becomes the placeholder. A model call
that ends `max-tokens` is still accepted when the text it emitted parses and
validates — a reasoning route can exhaust its budget before stopping.

### 2. Naming a specified conversation

`session_title_admin` with `{"action":"summarize","session_id":"…"}` reads the
WHOLE conversation — its opening intent plus the per-turn outcomes that fit a
byte budget, biased to the end where the result lives — and writes one
`MMDD｜类型｜主题` title for it. `dry_run:true` previews without writing. Live
sessions are written through `sessionTitle.rename`; cold ones through
`sessionController.rename`. The same date and type rules apply. Because `rename` is
a user rename, it also pins that session: later automatic revisions stop, and asking
the provider to refresh it again is the deliberate unpin.

Other actions: `list` (recent root sessions, their titles, the provider and trigger
state, the pending corrections, and recent automatic outcomes), `inspect` (one
session's first-turn evidence), `apply` (exact renames, each re-validated against
that session's own `createdAt`), `archive` (hide throwaway test sessions),
`selftest` (create a throwaway session and prove real automatic naming end to end).

### 3. Catch-up sweep after a crash or restart

The schedule belongs to the service, and a host that dies mid-turn or before the
first main request never reaches it. Five seconds after this plugin applies it
therefore refreshes recent root sessions that are **still without a compliant
title**, plus those **still carrying the deterministic placeholder**, inside a
bounded window. Either way the session must already contain assistant work: with
nothing produced there is nothing to classify, and a refresh would only rewrite the
same placeholder or replace a readable fallback with one. A placeholder is replaced
only once its own turn finished — a turn still running gets the `turn/end`
correction instead. A cold session is resumed through
`sessionController.resolveAgent` to obtain the live session the service needs; the
write stays provider-source, so it never pins.

| Bound | Value | Why |
|---|---|---|
| window | 48 h of `header.createdAt` | the crash case is minutes old; older sessions are reached when they are continued, or by `summarize` |
| cap | 5 refreshed per start | a start must never become a mass rename of history |
| delay | 5 s | the sweep must not compete with the host's own startup |

Each outcome lands in `auto.recent` (`named` / `placeholder` / `failed`, plus one
`sweep` line carrying the counts), so a start can be audited without reading logs.

## Choose one: this plugin or the official one

`ctx.sessionTitle.register()` accepts exactly ONE provider, and it throws
`session-title provider "…" is already registered` for a second one. The official
conversation-following plugin is the other claimant: its bundle patch disables the
same stock provider and inserts its own `all-prompts` provider
(`@deepseek-ai/dsh-session-title-all-prompts-llm`).

This plugin therefore declares the conflict instead of hiding it:

- Its own patch disables the stock first-prompt provider, so with the official
  plugin off it always gets the slot.
- If the official plugin is also enabled, the first one to activate wins and the
  other one fails — there is no "both work" configuration, no half-open state and
  no silent idle. This plugin fails loudly: activation throws, the plugin row shows
  **异常** in the plugin manager, and the host prints one `dsh: warning: N entries
  did not activate` line at startup. It never registers, never renames and never
  pins a title in that state.
- The plugin page text (from `locale/*.json`) says the same thing before the user
  flips a switch.

Pick exactly one: this plugin if you want the strict `MMDD｜类型｜主题` format, the
official one if you want its plain-text titles.

### Switching between them

The only stable configurations are "this plugin only" and "the official plugin only".
The recommended state is this plugin on and the official one off — which is also the
default, because the official bundle is not part of a profile until someone enables
it.

To switch to the official plugin:

1. Turn **this whole bundle** off in the plugin manager (Settings → Plugins → the
   `@chi-hong22/dsh-session-autoname` bundle row). The switch removes it from
   `dsh.profile.bundles` in `~/.dsh/profiles/<profile>/package.json`; it does not
   just disable the inner `session-autoname` row.
2. Restart the app so the provider slot is released.
3. Turn on **随对话更新的标题** (`@deepseek-ai/dsh-experimental-session-titles-bundle`,
   listed in the official/experimental group), then restart once more so its
   provider activates.

To switch back, do the same in the opposite order: official bundle off → restart →
this bundle on → restart.

Do not leave this bundle enabled while disabling only its inner `session-autoname`
row: the bundle patch is what keeps the stock first-prompt provider off, so that
state has **no working provider at all** and titles fall back to the service's
plain-text fallback. Either keep the bundle on, or turn the whole bundle off.

## Wiring

`cordis.patch.yml` is this bundle's patch layer: it frees the provider slot and
inserts this plugin.

```yaml
- id: session-title-llm
  disabled: true
- insert:
    - id: session-autoname
      name: '@chi-hong22/dsh-session-autoname'
```

The disable row names only the stock row's `id`, so it keeps that row's name and
config and makes no assumption about the text of the base layer. The insert row
names the package rather than a file URL, so the bundle runs wherever it is fetched
from — `github:Chi-hong22/dsh-session-autoname` included. A bare name is safe here
because an installed copy is immutable: the loader resolves each specifier once per
host process, and that single resolution points at the installed package for the
life of the process.

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
node --test tests/provider.test.mjs      # offline: the provider contract, rules, rejections, corrections, catch-up, admin tool
node tools/history-evidence.mjs 0        # read-only first-turn digests of root sessions
```

Then on a live host: `session_title_admin {"action":"selftest"}` for the automatic
path, and `{"action":"list"}` to read the provider state and recent outcomes.

## Known limits

- The title lags one turn: the service schedules the request before the turn's
  answer exists, so a first turn shows the placeholder and the corrected title lands
  at `turn/end`. Later turns update the title at the start of the following request.
- A first turn that ends `aborted`, `interrupted`, `error`, or `max-tokens` is
  named from the whole conversation instead of from that turn's partial result, and
  the model is told to stay conservative about the type.
- The type can drift only when the main task changed; a long conversation that keeps
  extending one task keeps its original type and wording on purpose.
- The catch-up sweep is bounded (48 h, 5 per start). A session older than the window
  that was never continued and never named keeps its placeholder until `summarize`
  is asked for it.
- `sessionController.rename` and `resolveAgent` resume a cold session, so naming one
  whose recorded `agentPreset` no longer exists fails with `Unknown agent preset`.
- `D:\__CODE__` is inside a file-sync scope on this machine, so in-place edits can
  briefly fail with a Windows sharing violation; retry.
