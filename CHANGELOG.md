# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-11-02

First release of the poog26 fork, renamed **omp-agent-sdk-bridge**. Targets Oh My Pi 18.15+
and Claude Agent SDK 0.3.308.

### Compliance and billing
- Forward the user's AGENTS.md / context text verbatim. 0.8 rewrote "omp" to
  "environment" and `~/.omp` to `~/.claude`, which hid the harness and broke paths.
- Identify the bridge through `CLAUDE_AGENT_SDK_CLIENT_APP`; drop a parent Claude
  Code session's markers so the SDK's own attribution is used.
- `provider.billing` (`subscription` default / `apiKey` / `inherit`): subscription
  mode strips API keys and gateway URLs so nothing silently redirects billing.
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
