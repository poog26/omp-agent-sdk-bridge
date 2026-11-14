# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.0] - 2026-11-14

### Removed
- The Claude-only cache footer and its process-wide totals. A conversation-wide cache
  indicator is outside the bridge's scope. Cache-miss detection, warnings, usage
  reconciliation and `/claude-usage` are unchanged.

### Fixed
- Tool input didn't stream: a `write`'s content appeared all at once after Claude finished
  generating it, instead of filling in live like OMP's own providers. The guard that keeps
  Claude Code from sending telemetry also stops it fetching the flag behind fine-grained tool
  streaming, so the bridge now sets Claude Code's documented
  `CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1` (an explicit `0` still opts out).
- Tool calls still didn't preview while streaming once the input arrived live: the bridge
  only parsed complete JSON, so a call's arguments stayed empty until Claude finished, and
  it kept the raw JSON where OMP's renderers don't look. Tool blocks now carry it on OMP's
  `setStreamingPartialJson` symbol and are parsed with `parseStreamingJsonThrottled`, the
  same as OMP's Anthropic provider, so `write`, `eval`, `bash` and the rest fill in as they
  stream. A contract check holds the bridge to OMP's own helpers.

## [0.9.0] - 2026-11-02

First release of the poog26 fork, renamed **omp-agent-sdk-bridge**. Targets Oh My Pi 18.15+
and Claude Agent SDK 0.3.308.

### Added
- A usage ledger (`~/.omp/agent/claude-bridge/usage-ledger.jsonl`) records every request
  Claude Code makes for the bridge: conversation turns, compaction summaries and titles,
  cache refreshes and AskClaude. Each conversation request is checked against the previous
  one of its session: a cache miss inside the cache lifetime is logged with its likeliest
  cause (tool list, system prompt or thinking changed, session rebuilt, or unexplained) and
  warned about from 20K tokens. Claude Code's per-query total is reconciled against the
  requests the bridge saw, so calls made outside the conversation are flagged. The footer
  shows the session's cache hit rate and any misses; `/claude-usage [hours]` summarizes the
  ledger. Measured before shipping: Claude Code made no calls beyond the streamed ones, and
  an aborted request's cache entry was read in full by the next one.
- OMP's Usage panel (`/usage`, `omp usage`) lists the Claude Bridge provider with its
  5-hour and weekly limits, reset times and account (from the SDK's `accountInfo()`).
  The figures come from the rate-limit reports Claude Code sends with each turn, kept in
  `~/.omp/agent/claude-bridge/usage.json` (percentages, reset times, email and plan name;
  nothing secret). Below the warning threshold those reports carry percentages only in a
  per-window breakdown the SDK doesn't type yet; it's read as optional display data.

### Fixed
- Compaction summaries, titles and recaps reported zero usage to OMP, so their tokens
  never showed in OMP's stats. They now carry the usage Claude Code reports.
- Idle gaps no longer lose Claude's prompt cache when a refresh would pay off. OMP's cache
  warmer only refreshes while idle if the expected saving clears $0.05, so a real 89K-token
  Opus conversation (expected saving ~$0.046, a miss ~24× a refresh) was never refreshed
  and missed after five minutes. On a Claude login the bridge now answers OMP's
  `cache_warming_decision` with a break-even rule (refresh when the expected saving beats
  the refresh). API keys keep OMP's rule, and `provider.cacheWarming: "omp"` restores it.
  Verified live: a refresh past four minutes idle read the whole prefix and wrote nothing,
  and the turn after a 5½-minute gap hit the cache.
- Claude turns now show cost in OMP's footer and stats, like other models. The bridge had
  zeroed every model's prices, so cost read $0 and the footer had nothing to show. Models
  keep OMP's list prices and are priced by OMP's own calculator, which also fills the
  cost total and honours the 5-minute / 1-hour cache-write split Claude Code reports. The
  figure is an API-equivalent estimate, not a charge against your plan. Turns from before
  this change keep their recorded zero cost.

### Changed
- Prompt caching. Claude Code is told to use the 5-minute cache (`provider.promptCacheTtl`,
  default `"5m"`) instead of the subscription's 1-hour default, whose writes cost 2x input
  against 1.25x; on real bridge sessions 5m was ~10% cheaper. OMP's cache warmer now works on
  bridge models: a refresh becomes an unsaved fork of the session (`forkSession` +
  `persistSession: false`) with the identical prompt, tools and settings, cut off once the
  usage arrives, instead of a new turn. Rebuilding the session after an abort, a failed turn
  or messages OMP added between turns keeps Claude Code's own records verbatim and converts
  only what follows; regenerating the whole transcript never matched what Claude Code had
  cached, so the next request re-wrote the whole conversation to the cache.
- The bridge configures Claude Code only through documented interfaces. Dropped the
  undocumented `CLAUDE_CODE_ELEGANT_MEADOW` flag, set `ENABLE_CLAUDEAI_MCP_SERVERS` to its
  documented value `false`, and added a test that fails if the child environment gains a
  variable not on the checked list. `AGENTS.md` records the compliance rules every change
  must meet, and the README's terms checklist now covers training on outputs and
  supervising computer-use actions.
- OMP tool schemas reach Claude exactly as OMP declares them. The old JSON Schema → Zod
  rebuild flattened nested objects, unions, `const` and `$ref`, so Claude saw e.g. the todo
  tool's `list` entries as "some object" with no field names. Each property now carries its
  original JSON Schema as Zod metadata, and argument validation is left to OMP, so a call
  the MCP layer would have rejected can no longer leave a tool call without its result.
- Messages sent while Claude runs a tool (e.g. waiting on a background job) now reach
  Claude mid-turn, as with native OMP models. The prompt is a long-lived input stream and
  the message is written to Claude Code (`priority: "next"`) before the tool result, so
  Claude answers it at that tool boundary while the job keeps running. Previously the
  bridge held such messages until the whole turn ended. Ported from pi-claude-bridge.
- OMP's personality is delivered as Claude Code's output style (from a bridge-owned local
  plugin), replacing the preset's terminal-tone section instead of being appended after it.
  `provider.personaAs: "append"` restores appending.
- Models with 1M included on every plan (Fable 5 / 5.1 / 5.2, Opus 5.5 / 5 / 4.8 / 4.7,
  Sonnet 5.5 / 5, Haiku 5.5) get a single picker entry, and so does any new model OMP's
  catalog lists at 1M, without waiting for a bridge update (`provider.forceTwoHundredK`
  pins one that Claude Code rejects at 1M). The 1M / 200K pair stays only where the
  window is a plan difference (Opus 4.6, Sonnet 4.6).

### Compliance and billing
- Forward the user's AGENTS.md / context text verbatim. 0.8 rewrote "omp" to
  "environment" and `~/.omp` to `~/.claude`, which hid the harness and broke paths.
- Identify the bridge through `CLAUDE_AGENT_SDK_CLIENT_APP`; drop a parent Claude
  Code session's markers so the SDK's own attribution is used.
- `provider.billing` (`inherit` default / `subscription` / `apiKey`). The default
  leaves Claude Code's auth untouched, as Anthropic's terms require of products that
  run it, and warns once when an API key, gateway URL or cloud switch would bill
  something other than the Claude login; `subscription` strips those as an opt-in.
- AskClaude UI no longer uses "Claude Code" as a feature name or badge ("Ask Claude").
- README: a "using it within the terms in OMP" checklist, including not logging in
  to OMP's built-in Anthropic provider with a Claude subscription.
- Extra Usage guard: a request billed to Extra Usage is reported and the turn is
  stopped unless `provider.allowExtraUsage` is set. Extra Usage / login errors get
  actionable messages.
- Stop setting `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` on OMP's own process.

### Security
- `provider` settings are global-only: a cloned repo's `.omp/claude-bridge.json`
  could set `pathToClaudeCodeExecutable` and have it executed.
- A project config can only narrow AskClaude, never enable full mode.
- Load only user-level Claude Code settings (a repo's `.claude/settings*.json`
  hooks ran without a prompt); user hooks and output style are off by default.
- Provider turns use `dontAsk` with an allow rule for OMP's MCP tools instead of
  `bypassPermissions`.
- AskClaude `read` / `none` modes are allowlists without permission bypass; the old
  blocklist let `PowerShell` and `Monitor` run in "read-only" mode on Windows.

### Fixed
- Works with OMP 18 and current Claude Code: Agent SDK 0.2 → 0.3.308 (the API
  rejects old clients), removed `keyHint` import.
- Skills never reached Claude on OMP 18 (new `<skills>` format); personality,
  `APPEND_SYSTEM.md` and the full project context were never forwarded at all.
- Newest models (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1, Opus 5) were missing:
  the picker now follows OMP's catalog with a measured 1M table.
- Registered context window now leaves Claude Code's blocking margin (977K / 177K),
  so OMP compacts before "Prompt is too long".
- Rate-limit warnings never fired (utilization is a fraction) and showed 1970 reset
  times (`resetsAt` is seconds).
- One global session mirror was shared by every OMP session; subagents and side
  requests now get their own, and side-request mirrors are deleted afterwards.
- Mirrors use a stable id per OMP session, so restarts stop leaving session files.
- Compaction, titles and recaps run through an isolated one-shot path; the
  `session_before_compact` takeover (and its handler-timeout races) is gone.
- OMP 18 `developer` messages were dropped from history and broke prompts.
- Thinking `off` now disables thinking; effort is clamped to each model's levels.
- Claude Code error results, and rate limits arriving after a tool call, were
  swallowed; they now end the turn as errors (parked across tool execution).
- The injected bash `timeout: 120` busted the prompt cache on rebuilds.
- AskClaude resumed a stale provider session; it now syncs current history into its
  own mirror and forks it. Uses OMP's cwd instead of `process.cwd()`.
- Session-shutdown closes parked Claude Code processes.
- Windows path shortening in AskClaude progress.

## [0.8.1] - 2026-07-07

### Fixed
- Spurious "Claude rate limit warning" toasts at trivial utilization. The Claude
  Agent SDK emits `allowed_warning` rate-limit events even at ~1% of the
  `seven_day` (weekly) limit; these are now surfaced only at ≥80% utilization.
  Hard-limit (`rejected`) notifications and the debug log are unchanged.

## [0.8.0] - 2026-07-07

### Added
- On-demand context-window variants in the `/model` picker: each model is now
  registered once per window it supports (1M and/or 200K) as a distinct,
  clearly-labeled entry (e.g. `Opus 4.8 (1M)` and `Opus 4.8 (200K)`). Switching
  a model's context window is a picker selection instead of a config edit plus
  reload.
- Suffixed model ids (`<model>-1m` / `<model>-200k`) that force a specific
  window regardless of the global default — usable from `modelRoles` and
  AskClaude short names. The unsuffixed id remains the config default, so
  existing `config.yml` roles keep working.

### Changed
- `provider.contextWindow` now sets the **default** window (which window the
  unsuffixed model id maps to) instead of hiding models that don't match it.
  Both windows stay pickable wherever a runtime exists.
- Each variant reports its true `contextWindow`, keeping the status bar and
  auto-compaction accurate for the selected window.

## [0.7.0] - 2026-07-06

First public release of the Oh My Pi port.

### Added
- `provider.contextWindow` setting with three modes:
  - `"auto"` (default) — per-model context policy based on measured SDK behavior.
  - `"1m"` — force the 1M context window; only 1M-capable models are registered.
  - `"200k"` — force the 200K context window; only 200K-capable models are registered.
- Models without a runtime for the selected forced window are hidden from the
  model picker instead of being misreported.
- `thinkingLevelMap` fallback so Sonnet 5 / Sonnet 4.6 expose `xhigh` (mapped to `max`).

### Changed
- Ported from Pi (`@earendil-works/*`) to Oh My Pi (`@oh-my-pi/*`): extension
  manifest (`omp.extensions`), provider registration, message conversion, and
  config directory resolution (`~/.omp/agent/claude-bridge.json`).
- Corrected the `claude-fable-5` context policy: the bare `claude-fable-5`
  runtime serves 200K (verified), while `claude-fable-5[1m]` serves 1M. In
  `"auto"` mode Fable 5 now registers at 200K.

### Credits
- Original `pi-claude-bridge` by [Eli Dickinson](https://github.com/elidickinson).
- Oh My Pi port and context-window controls by [Jonathan Borgwing](https://github.com/DevVig).
