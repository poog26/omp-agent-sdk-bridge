# omp-agent-sdk-bridge

> **This is an updated version** of [DevVig/omp-claude-bridge](https://github.com/DevVig/omp-claude-bridge), which is itself an Oh My Pi port of Eli Dickinson's [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge). It has been rebuilt for Oh My Pi 18.15+ and the current Claude Agent SDK, with security, billing and compliance fixes; see the [CHANGELOG](CHANGELOG.md).
>
> **If you've come across this repository:** don't install it blind. Ask your own Claude Opus 5.5 (for example in Claude Code) to integrate it for you. It can check that your OMP and Claude Code versions are compatible, set up the config for your plan, and verify that everything works on your machine, so you don't run into problems. You can paste this:
>
> *"Review https://github.com/poog26/omp-agent-sdk-bridge, then install and integrate it into my Oh My Pi setup. Check that my OMP and Claude Code versions are compatible, set up claude-bridge.json for my Claude plan, and verify it with a short test turn."*

An [Oh My Pi](https://omp.sh) extension that uses the official [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript) to run Claude as an OMP model provider. OMP keeps its TUI, tools, approvals, sessions and memory. Claude Code's unmodified binary handles each model turn under your own Claude login.

- **Claude in `/model`**: every Claude model in OMP's catalog appears automatically (Fable, Opus, Sonnet, Haiku), at 1M wherever your plan includes it.
- **Your OMP setup reaches Claude**: your `PERSONALITY.md`, skills, rules, AGENTS.md/context files and `APPEND_SYSTEM.md` are forwarded verbatim.
- **No surprise billing**: a warning when your environment would bill something other than your Claude login, and the bridge stops a turn that would be billed to Extra Usage unless you opt in.
- **AskClaude tool**: when another provider is active, delegate a review or question to Claude (read-only by default).

Requires OMP ≥ 18.15 and a working Claude Code login. Tested on Windows 11 with OMP 18.15 and Claude Code 2.1.308.

## Terms of Service: what this does and doesn't do

This fork stays inside Anthropic's published terms, and the design choices below follow from that:

| | |
| --- | --- |
| **Uses the official Agent SDK and the unmodified Claude Code binary** | Anthropic's [legal & compliance page](https://code.claude.com/docs/en/legal-and-compliance) explicitly allows *"an end user signing in to the unmodified Claude Code binary with their own Claude subscription"*. Its [plan article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) (updated October 7, 2026) says Agent SDK usage signed in with your plan draws from your subscription limits. |
| **Never touches credentials** | Login happens in Claude Code (`claude` → `/login`) through Anthropic's own flow. The bridge never reads, stores or forwards tokens, and sends nothing through a proxy: Claude Code talks to Anthropic directly. |
| **Leaves Claude Code's login options alone** | Products that run Claude Code may not *"remove, disable, or restrict any authentication method built into it"*. By default the bridge passes your environment through unchanged and only *warns* if it would route Claude somewhere other than your Claude login. Restricting to the Claude login (`billing: "subscription"`) is your own opt-in. |
| **Honest attribution** | Requests carry the SDK's genuine `cc_entrypoint=sdk-ts` attribution, and the bridge names itself via `CLAUDE_AGENT_SDK_CLIENT_APP=omp-agent-sdk-bridge/<version>`, the mechanism the SDK documents for apps built on it. Nothing is spoofed. |
| **Forwards your words as written** | Earlier versions rewrote "omp" → "environment" and `~/.omp` → `~/.claude` in your AGENTS.md. This fork forwards your content verbatim. |
| **Respects billing classification** | If Anthropic classifies a request as Extra Usage, the bridge reports it and (by default) stops. To be transparent: OMP's own harness instructions are left out of the prompt because Claude Code's preset already provides the agent framework (see [What reaches Claude](#what-reaches-claude)), not to influence billing, and nothing is renamed or disguised. |
| **Documented interfaces only** | Claude Code is configured only through options, CLI flags, settings and environment variables that Anthropic documents. Undocumented internal flags are never set, and a unit test enforces that for the environment. |
| **For personal use** | The terms forbid *developers* offering claude.ai login to *their users*, or routing requests through other people's plans. Use this with your own login on your own machine. Don't host it for others or share a login. |

Usage limits on Pro/Max/Ultra *"assume ordinary, individual usage of Claude Code and the Agent SDK"*, and Anthropic reserves the right to enforce without notice. If you want zero ambiguity, set `"billing": "apiKey"` and use a Claude Console key.

**Using it within the terms in OMP**

- **Don't log in to OMP's built-in `anthropic` provider with your Claude Pro/Max account** (OMP's `/login` → Anthropic). That gives a third-party app your claude.ai token, which is exactly what the terms prohibit. Use the `claude-bridge/…` models; they go through Claude Code's own login.
- Use your own Claude login, on your own machine, for your own work. Don't share the login or run the bridge for other people.
- Keep unattended automation off your subscription. Scheduled or always-on agents, and large subagent fleets running while you're away, are where *"ordinary, individual usage"* ends; use an API key (`billing: "apiKey"`) for that.
- OMP's cache warming sends small automatic refreshes for the conversation you're in, and only for a bounded time after you last used it (30 minutes idle, 60 minutes during a run), to avoid re-sending the whole context. That serves your own interactive work and reduces load; it isn't an always-on agent. Turn `providers.cacheWarming` off if you'd rather have no requests you didn't trigger.
- OMP's background roles (`modelRoles` such as `smol`) are fine on `claude-bridge/…` models as far as the terms go: they serve your own interactive work, the way Claude Code uses a small model for titles and summaries. They do count against your plan limits and add a few seconds per call while Claude Code starts, so a cheap, fast model is usually the better pick for them.
- Your prompts remain subject to Anthropic's [Usage Policy](https://www.anthropic.com/legal/aup), as they would be in Claude Code.
- Don't use Claude's outputs to train or fine-tune a model (the Usage Policy effective November 12, 2026 forbids it without Anthropic's authorization, and the Consumer Terms already did). Keeping them in a memory or notes system is fine; turning them into a training set is not.
- You're responsible for what the agent does through its tools, including OMP's computer use and browser tools. Supervise input actions, and don't use them to get around another site's terms or bot checks (CAPTCHAs, rate limits, sign-up automation).

## Install

```bash
omp plugin install git:github.com/poog26/omp-agent-sdk-bridge
```

Update later with `omp plugin upgrade omp-agent-sdk-bridge`.

From a local checkout:

```bash
git clone https://github.com/poog26/omp-agent-sdk-bridge.git
omp plugin install ./omp-agent-sdk-bridge
```

Then:

1. Log in to Claude Code once: run `claude` in a terminal and type `/login`. The bridge uses Claude Code's login, not OMP's `/login`.
2. In OMP, pick a `claude-bridge/…` model with `/model`, e.g. `claude-bridge/claude-opus-5-5`.

To try it without installing: `omp -e /path/to/omp-agent-sdk-bridge/src/index.ts --model claude-bridge/claude-sonnet-5-5`.

## Models and context windows

The picker follows OMP's Anthropic catalog, so new Claude models appear when OMP updates. Dated snapshot ids are hidden, and so is Mythos (not served to claude.ai plans; set `provider.excludeModels: []` to show it).

Newer models have 1M included on every plan, so they get **one entry at 1M**. A separate 200K entry would only compact earlier, and OMP's own compaction threshold (`compaction.thresholdTokens`) already does that for any model. A second entry appears only where the window is a real plan difference; there the plain id is the default and the other gets a `-1m` / `-200k` suffix:

| Model | Picker entries |
| --- | --- |
| Fable 5 / 5.1, Opus 5.5 / 5 / 4.8, Sonnet 5.5 / 5, Haiku 5.5 | one, 1M (included on every plan) |
| Opus 4.7 | one, 1M (Claude Code serves no 200K runtime for it) |
| Opus 4.6 | 200K + `-1m`; 1M is the default on Max (`plan: "max"`) or with `longContextExtraUsage` |
| Sonnet 4.6 | 200K + `-1m`; 1M is the default with `longContextExtraUsage` |
| Haiku 4.5 and other 200K-only models | one, 200K |
| new models nobody has measured yet | 200K + `-1m` to try; asking for 1M on a plan that doesn't include it fails every turn, so 200K is the safe default |

`provider.contextWindow: "200k"` makes 200K the default everywhere; `provider.forceTwoHundredK` pins individual models to 200K.

**Usable window.** Claude Code refuses requests locally at `window − 23K` (977K on 1M, 177K on 200K). The bridge registers that usable size, so OMP's auto-compaction fires before Claude Code would refuse. The picker label still names the served window.

Thinking levels map to Claude Code's effort, clamped to what each model supports (e.g. `xhigh` on Sonnet 4.6 sends `high`). `off` really turns thinking off.

## What reaches Claude

Claude Code's own `claude_code` system prompt stays the agent framework. Appended to it, verbatim, are the parts of OMP's prompt that are *yours*:

| From OMP | Forwarded | Setting |
| --- | --- | --- |
| Personality (`PERSONALITY.md` or preset) | yes, as Claude Code's **output style** (see below) | `provider.forward.personality`, `provider.personaAs` |
| Skills, always-apply rules, domain rules | yes; `skill://` / `rule://` read through OMP's tool | `provider.forward.skills` |
| `<project-context>`: workstation, AGENTS.md / context files, workspace tree | yes | `provider.forward.projectContext` |
| `APPEND_SYSTEM.md` / `--append-system-prompt` | yes | `provider.forward.appendText` |
| OMP's harness instructions (role, tool policy, workflow) | no: Claude Code's preset covers this, and two frameworks in one prompt compete | — |

**Your OMP persona is the voice, not Claude Code's CLI tone.** Claude Code's prompt contains a tone section written for a terminal ("be concise", CLI formatting). Output styles are Claude Code's own feature for replacing exactly that section. The bridge writes OMP's personality block into a small plugin it owns (`~/.omp/agent/claude-bridge/persona-plugin/`) and selects it as the output style, with `keep-coding-instructions: true` so Claude keeps its coding guidance. `PERSONALITY.md` stays the single source: edit it and the next session picks it up. Nothing is written into your `~/.claude`.

Kept **out** of bridge turns by default, because OMP owns these:

- your `~/.claude/settings.json` **hooks** (notifications, memory capture…) → `provider.claudeHooks: true` to allow
- your Claude Code **output style** (OMP's persona takes its place) → `provider.claudeOutputStyle: true` to use yours instead
- Claude Code's own `CLAUDE.md` / `AGENTS.md` loading (OMP already forwards context files)
- Claude Code auto-memory → `provider.autoMemoryEnabled: true`
- MCP servers from `~/.claude.json` / `.mcp.json` and claude.ai connectors
- a repository's `.claude/settings*.json` (could carry hooks that run without a prompt)

## Billing and limits

- `provider.billing: "inherit"` (default) leaves Claude Code's environment as it is, so it chooses its login exactly as when you run `claude` yourself. If `ANTHROPIC_API_KEY`, a non-Anthropic `ANTHROPIC_BASE_URL` or a cloud-provider switch is set, the bridge warns once per session that requests will bill that instead of your Claude login.
- `provider.billing: "subscription"` removes `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and cloud-provider switches from Claude Code's environment, so a key exported for some other tool can't silently redirect (and bill) the bridge. `"apiKey"` requires a Claude Console key; `"inherit"` passes the environment through unchanged.
- Rate-limit toasts at 80%+ of a window (5-hour / weekly), with the real reset time.
- **OMP's Usage panel** (`/usage`, `omp usage`) lists *Claude Bridge* with your 5-hour and weekly limits and your account. The figures are the ones Claude Code reports with each Claude turn, so they update when you use Claude rather than on a timer. The bridge never reads your login to ask Anthropic for them.
- **Cost shown in the footer and stats** is an *API-equivalent estimate*: each turn's tokens priced at OMP's list prices for the Claude model, the same way OMP prices every other model. Your Claude plan doesn't bill per token, so this is what the usage would cost on the API, not a charge. Cache writes are priced at the 5-minute or 1-hour rate Claude Code reports.
- **Extra Usage guard**: when a request is billed to Extra Usage, the bridge says so and stops the turn. Set `provider.allowExtraUsage: true` to continue on Extra Usage.

### Prompt caching

- **5-minute cache by default.** On a subscription Claude Code would otherwise write 1-hour cache entries, which cost 2× input against 1.25× for 5-minute ones (reads cost the same). Replayed over 21 real bridge sessions, 5 minutes came out about 10% cheaper, the extra misses from longer pauses included. Set `provider.promptCacheTtl` to `"1h"` for long idle gaps, or `"default"` to leave Claude Code's own choice. It uses Claude Code's documented `CLAUDE_CODE_PROMPT_CACHE_TTL` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`.
- **OMP's cache warming works on bridge models.** When OMP refreshes a cache entry shortly before it expires (`providers.cacheWarming`), the bridge sends Claude Code a side request that leaves no trace: an unsaved fork of the session (`forkSession` + `persistSession: false`) with the same model, prompt, tools and settings, stopped as soon as the usage arrives. Its few tokens of refresh text are reported as input rather than a cache write, so OMP sees that the refresh landed on the entry; the cost shown stays exact. OMP decides whether each refresh is worth its cost and stops after its own windows (30 minutes idle, 60 minutes during a run). Refreshes are requests on your plan, so turn `providers.cacheWarming` off in OMP if you'd rather not have them.
- **Rebuilds keep the cache.** After an aborted or failed turn, or when OMP adds messages between turns, the bridge keeps Claude Code's own session records verbatim and converts only what came after. Earlier versions regenerated the whole transcript, which never matched what Claude Code had cached, so the next request wrote the whole conversation to the cache again.

## AskClaude tool

Available whenever the active provider is **not** claude-bridge. Ask your current model to *"ask Claude to review this plan"*, *"ask Claude where auth is handled"*, and so on.

| Parameter | Values | |
| --- | --- | --- |
| `prompt` | string | The question or task. |
| `mode` | `read` (default), `none`, `full` | `read` = Read/Glob/Grep/WebFetch/WebSearch only, nothing else exists; `none` = no tools; `full` = Claude Code's full toolset including writes and bash. |
| `model` | `opus` (default), `sonnet`, `haiku`, `fable`, or a full id | Family names pick the newest model of that family. |
| `thinking` | `off` … `max` | Effort level. |
| `isolated` | boolean | `true` = clean session; `false` (default) = Claude sees the current conversation. |

`read` and `none` use an allowlist with permission prompts off, so Claude Code tools added in the future (or Windows-only ones like PowerShell) can't slip in. Lock out `full` with `askClaude.allowFullMode: false`; the tool then also registers with OMP's read-only approval tier.

## Configuration

Global: `~/.omp/agent/claude-bridge.json`. Project: `.omp/claude-bridge.json`, which can only *narrow* `askClaude` (it can't enable full mode). **`provider` settings are global-only**, so a cloned repository can't point the bridge at its own executable, change billing, or turn hooks on. See [`claude-bridge.example.json`](claude-bridge.example.json).

**`provider`**

| Key | Default | |
| --- | --- | --- |
| `billing` | `"inherit"` | `"inherit"`, `"subscription"` (Claude login only) or `"apiKey"`. |
| `allowExtraUsage` | `false` | Keep going when a request is billed to Extra Usage. |
| `plan` | `"pro"` | `"max"` defaults Opus 4.6 to 1M. |
| `longContextExtraUsage` | `false` | Metered 1M for Sonnet 4.6 / Opus 4.6 on Pro. |
| `contextWindow` | `"auto"` | Default window: `"auto"` (measured per model), `"1m"`, `"200k"`. |
| `forceTwoHundredK` | — | Model ids whose default window is pinned to 200K. |
| `excludeModels` | `["mythos"]` | Id substrings hidden from the picker. |
| `forward` | all `true` | `personality`, `skills`, `projectContext`, `appendText`. |
| `claudeHooks` | `false` | Run `~/.claude/settings.json` hooks on bridge turns. |
| `personaAs` | `"outputStyle"` | `"outputStyle"`: OMP's persona replaces Claude Code's terminal-tone section. `"append"`: added after Claude Code's prompt instead. |
| `claudeOutputStyle` | `false` | Use your own Claude Code output style instead of OMP's persona. |
| `autoMemoryEnabled` | `false` | Let Claude Code write its auto-memory. |
| `strictMcpConfig` | `true` | Ignore MCP servers from `~/.claude.json` / `.mcp.json`. |
| `promptCacheTtl` | `"5m"` | Prompt-cache lifetime: `"5m"`, `"1h"`, or `"default"` (Claude Code decides). See [Prompt caching](#prompt-caching). |
| `pathToClaudeCodeExecutable` | — | Use this `claude` binary instead of the SDK's bundled one. |

**`askClaude`**: `enabled` (true), `name`, `label`, `description`, `defaultMode` (`"read"`), `defaultModel` (`"opus"`), `defaultIsolated` (false), `allowFullMode` (true), `forward` (personality off by default).

## How it works

- **Provider turns**: Claude Code runs with its built-in tools off. OMP's tools are served over an in-process MCP server; Claude Code may call only those (`dontAsk` with an allow rule for that one server), and OMP executes them with its own approvals.
- **Session mirrors**: each OMP session has one Claude Code session mirror under a stable id derived from OMP's session id. Unchanged history resumes it (prompt cache stays warm); edits, `/compact` and tree navigation rebuild it from OMP's history, overwriting the same file. OMP subagents and side requests get mirrors of their own, so they can't disturb the main conversation's cache.
- **Messages mid-turn**: a message you send while Claude runs a tool (say, waiting on a background job) is written into the running Claude Code session ahead of that tool's result, so Claude reads and answers it at once while the job continues. The same as a native OMP model.
- **One-shot calls**: tool-less calls (compaction summaries, titles, recaps, handoffs) run as isolated, unpersisted single-turn queries with OMP's own prompt for that call. They never touch a mirror.
- **Failures**: Claude Code error results end the turn as an error (so OMP's retry/fallback chains can act), with guidance for login and Extra Usage problems. A failure that arrives while OMP is running a tool is delivered on OMP's next call instead of being lost.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1`:

- `~/.omp/agent/claude-bridge.log`: every provider call, sync decision, served context window, rate-limit event (override with `CLAUDE_BRIDGE_DEBUG_PATH`)
- `~/.omp/agent/cc-cli-logs/`: Claude Code's own debug log per query

## Development

```bash
npm install
npm run typecheck
npm test                 # unit tests (node)
npm run test:contract    # renders OMP's real system prompt + config loader (needs bun)
npm run test:live        # real calls through your Claude login: one-shot path + AskClaude read mode (needs bun)
```

## Credits

- **[pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge)** by Eli Dickinson: the streaming provider, MCP tool bridge, session sync and AskClaude this builds on, plus the measured context-window and Extra Usage research.
- **Oh My Pi port** and on-demand 1M/200K variants by Jonathan Borgwing ([DevVig/omp-claude-bridge](https://github.com/DevVig/omp-claude-bridge)).
- Initial inspiration from [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal.

"Claude" and "Claude Code" are trademarks of Anthropic. This is an independent project, not built, endorsed or supported by Anthropic.

## License

[MIT](LICENSE). See [NOTICE](NOTICE) for attribution.
