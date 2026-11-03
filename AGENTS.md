# Working on this repository

This bridge runs Claude through the official Agent SDK under the user's own Claude
login. Staying inside Anthropic's terms is the one hard requirement: a change that
breaks a rule below does not ship, however useful it is. When a rule and a feature
conflict, drop the feature or put it behind an API key.

The sources, re-read before any change that touches auth, the prompt, the child
process or billing:

- Claude Code legal & compliance: https://code.claude.com/docs/en/legal-and-compliance
- Consumer Terms: https://www.anthropic.com/legal/consumer-terms
- Usage Policy (version effective 2026-11-12): https://www.anthropic.com/legal/aup
- Agent SDK with a Claude plan: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan

## Compliance rules

1. **Unmodified binary.** Claude Code runs exactly as Anthropic publishes it. No
   patching, wrapping or replacing it, and no binary-level tricks.
2. **Never restrict its auth.** No default may remove, disable or restrict an
   authentication method built into Claude Code. `billing: "subscription"` stays an
   explicit opt-in, and the default (`inherit`) passes the environment through.
3. **Never touch credentials.** Don't read, store, forward, log or proxy claude.ai
   tokens or API keys. Login happens only through Claude Code's own flow, and the
   bridge never offers a claude.ai login of its own.
4. **Honest attribution.** Keep the SDK's own `cc_entrypoint`, and name the bridge
   with `CLAUDE_AGENT_SDK_CLIENT_APP`. Never spoof Claude Code's CLI, another client,
   headers or user agents.
5. **Documented interfaces only.** Configure Claude Code only through documented
   SDK options, CLI flags, settings and environment variables
   (https://code.claude.com/docs/en/env-vars, https://code.claude.com/docs/en/cli-reference,
   the SDK's typed options). Don't set undocumented or codename flags, and don't go
   digging in the binary or minified bundles for hidden behaviour. A new variable goes
   into `DOCUMENTED_CHILD_ENV` in `tests/unit-modules.mjs` only after it has been
   checked against the docs.
6. **No billing games.** Never reshape, rename or disguise prompts to influence how
   Anthropic classifies usage (Extra Usage or otherwise). Forward the user's content
   verbatim. If a request is classified as Extra Usage, report it and stop unless the
   user opted in with `allowExtraUsage`.
7. **Personal, ordinary use.** The subscription route is for one person's own
   interactive work. Don't add features that serve other people's requests through it,
   resell or proxy access, or run unattended (scheduled jobs, always-on agents, large
   fleets). Those go through `billing: "apiKey"`, and the docs must say so.
8. **No training on outputs.** Nothing in the bridge collects Claude's outputs for
   training or fine-tuning a model.
9. **Branding.** "Claude Code" and "Anthropic" never appear in product, feature or
   UI-label names. Plain factual mentions ("runs Claude Code") are fine.
10. **Agent actions stay the user's.** Tool, computer-use and browser actions are the
    user's responsibility under the Usage Policy. Don't add anything that bypasses
    approvals, safety checks, or the guardrails or terms of other services.

## Testing against the live service

Live runs use the user's own plan, so keep them small and few: a cheap model,
short prompts, and only as many runs as it takes to verify the change. Prefer the
unit and contract tests, which need no login.

## Checklist for every change

- Does it touch auth, credentials, the child environment, CLI flags, the prompt,
  attribution or billing? Re-check the rules above against the current pages.
- `npm test`, `npm run typecheck` and `npm run test:contract` pass.
- README's "Using it within the terms" section still matches what the code does.
