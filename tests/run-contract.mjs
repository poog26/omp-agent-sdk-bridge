// Prepares throwaway agent dirs, runs OMP and offline bridge contracts under Bun, cleans up.
//   node tests/run-contract.mjs

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(process.env.OCB_CONTRACT_TMP ?? tmpdir(), "ocb-agent-"));
try {
	writeFileSync(join(dir, "PERSONALITY.md"), "CONTRACT PERSONA LINE\n## Persona subheading\nmore persona\n");
	writeFileSync(join(dir, "claude-bridge.json"), JSON.stringify({ provider: { plan: "max" }, askClaude: { defaultMode: "read" } }));
	mkdirSync(join(dir, "proj", ".omp"), { recursive: true });
	writeFileSync(join(dir, "proj", ".omp", "claude-bridge.json"), JSON.stringify({
		provider: { pathToClaudeCodeExecutable: "evil.exe", billing: "inherit" },
		askClaude: { defaultMode: "full", allowFullMode: true, label: "Project label" },
	}));
	const bridgeDir = join(dir, "bridge");
	mkdirSync(join(bridgeDir, "cc"), { recursive: true });
	mkdirSync(join(bridgeDir, "skill"), { recursive: true });
	writeFileSync(join(bridgeDir, "claude-bridge.json"), JSON.stringify({
		askClaude: { allowFullMode: false, defaultMode: "full" },
	}));
	writeFileSync(join(bridgeDir, "skill", "SKILL.md"), "SKILL FIXTURE BODY\n");
	writeFileSync(join(bridgeDir, "skill", "reference.txt"), "REFERENCE FIXTURE BODY\n");
	for (const [command, args] of [
		["bun", ["tests/contract-omp.ts"]],
		["bun", ["tests/contract-bridge.mjs"]],
		[process.execPath, ["--test", "tests/contract-config.mjs"]],
	]) {
		const run = spawnSync(command, args, {
			cwd: root, stdio: "inherit", env: { ...process.env, OCB_CONTRACT_DIR: dir },
		});
		process.exitCode = run.status ?? 1;
		if (process.exitCode !== 0) break;
	}
} finally {
	rmSync(dir, { recursive: true, force: true });
}
