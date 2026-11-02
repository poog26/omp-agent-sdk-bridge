# Contributing to omp-claude-bridge

Thanks for your interest in improving **omp-claude-bridge**. Contributions of all
sizes are welcome — bug reports, docs fixes, and features alike.

## Getting set up

```bash
git clone https://github.com/poog26/omp-claude-bridge.git
cd omp-claude-bridge
npm install
```

Requirements:
- Node.js >= 20
- npm, plus [Bun](https://bun.sh) for the OMP contract and live tests
- An Oh My Pi install for end-to-end testing ([omp.sh](https://omp.sh))

## Developing against a live Oh My Pi

Point Oh My Pi at your working copy so changes load on the next run:

```bash
omp -e /absolute/path/to/omp-claude-bridge/src/index.ts   # one run
omp plugin install /absolute/path/to/omp-claude-bridge   # persistent
```

Enable debug logging while iterating:

```bash
CLAUDE_BRIDGE_DEBUG=1 omp --list-models claude-bridge
# logs -> ~/.omp/agent/claude-bridge.log
```

## Checks before opening a PR

```bash
npm run typecheck
npm test                 # unit tests
npm run test:contract    # against OMP's real prompt builder (bun)
```

Please make sure these pass. CI runs them on Linux and Windows for every pull request.

## Coding guidelines

- TypeScript, ESM, tabs for indentation (match the surrounding files).
- Keep model routing changes in `src/models.ts`. It has **no runtime imports**,
  so it stays unit-testable in isolation — add a case to
  `tests/unit-context-window.mjs` when you touch context routing.
- Keep requests honestly attributed: forward user content verbatim and never
  reshape prompts to influence Anthropic's billing classification.
- Context-window behavior is derived from **measured** Claude Agent SDK output,
  not advertised metadata. If you change a model mapping, note how you verified
  the served window (the `result: served contextWindow=...` debug line).

## Reporting bugs

Open an issue using the bug template. A `~/.omp/agent/claude-bridge.log` excerpt
(run with `CLAUDE_BRIDGE_DEBUG=1`) makes bugs far easier to reproduce.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
