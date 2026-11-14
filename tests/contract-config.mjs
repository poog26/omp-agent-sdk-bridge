import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const CONFIG_DIR_NAME = ".omp";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Config loads OMP's Bun-native utilities. Keep fixture I/O in Node, as the
// contract runner does, and execute the real loader in its supported runtime.
function configCall(input, warn = console.error) {
	const source = `
		import { loadConfig, validateConfig } from "./src/config.ts";
		const input = JSON.parse(process.argv[1]);
		const warnings = [];
		console.error = (message) => warnings.push(message);
		const config = input.op === "load" ? loadConfig(input.cwd, input.path)
			: validateConfig(input.config, (message) => warnings.push(message));
		console.log(JSON.stringify({ config, warnings }));
	`;
	const { config, warnings } = JSON.parse(execFileSync("bun", ["-e", source, JSON.stringify(input)], { cwd: root, encoding: "utf8" }));
	warnings.forEach(warn);
	return config;
}
const loadConfig = (cwd, path) => configCall({ op: "load", cwd, path });
const validateConfig = (config, warn) => configCall({ op: "validate", config }, warn);

function loadFixture(t, global, project) {
	const root = mkdtempSync(join(tmpdir(), "bridge-config-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project");
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	const globalPath = join(root, "global.json");
	writeFileSync(globalPath, JSON.stringify(global));
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"), JSON.stringify(project));
	return loadConfig(cwd, globalPath);
}

test("project customization preserves globally disabled AskClaude and isolation", (t) => {
	const config = loadFixture(t, {
		askClaude: { enabled: false, defaultIsolated: true, name: "AskGlobal", label: "Global" },
	}, {
		askClaude: { enabled: true, defaultIsolated: false, name: "AskProject", label: "Project", description: "Project helper", defaultModel: "sonnet" },
	});
	assert.equal(config.askClaude.enabled, false);
	assert.equal(config.askClaude.defaultIsolated, true);
	assert.equal(config.askClaude.name, "AskProject");
	assert.equal(config.askClaude.label, "Project");
	assert.equal(config.askClaude.description, "Project helper");
	assert.equal(config.askClaude.defaultModel, "sonnet");
});

test("project defaults can only narrow the global effective mode", (t) => {
	for (const [globalMode, projectMode, expected] of [
		["none", "read", "none"],
		["none", "full", "none"],
		["read", "none", "none"],
		["read", "full", "read"],
		["full", "read", "read"],
		["full", "none", "none"],
		[undefined, "full", "read"],
		[undefined, "none", "none"],
	]) {
		const config = loadFixture(t, { askClaude: { defaultMode: globalMode } }, { askClaude: { defaultMode: projectMode } });
		assert.equal(config.askClaude.defaultMode ?? "read", expected, `${globalMode} -> ${projectMode}`);
	}
});

test("project can disable delegation, require isolation, and forbid full mode", (t) => {
	const config = loadFixture(t, {
		askClaude: { enabled: true, defaultIsolated: false, allowFullMode: true },
	}, {
		askClaude: { enabled: false, defaultIsolated: true, allowFullMode: false },
	});
	assert.equal(config.askClaude.enabled, false);
	assert.equal(config.askClaude.defaultIsolated, true);
	assert.equal(config.askClaude.allowFullMode, false);
});

test("partial project forwarding keeps all globally disabled fields", (t) => {
	const config = loadFixture(t, {
		askClaude: { forward: { personality: false, skills: false, projectContext: false, appendText: true } },
	}, {
		askClaude: { forward: { skills: true, appendText: false } },
	});
	assert.deepEqual(config.askClaude.forward, { personality: false, skills: false, projectContext: false, appendText: false });
});

test("project forwarding cannot restore disabled fields or opt into personality", (t) => {
	for (const personality of [undefined, false]) {
		const globalForward = { skills: false, projectContext: false, appendText: false, ...(personality === false ? { personality } : {}) };
		const config = loadFixture(t, {
			askClaude: { forward: globalForward },
		}, {
			askClaude: { forward: { personality: true, skills: true, projectContext: true, appendText: true } },
		});
		assert.deepEqual(config.askClaude.forward, globalForward);
	}
});

test("project forwarding can remove more context without dropping global settings", (t) => {
	const config = loadFixture(t, {
		askClaude: { forward: { personality: true, skills: true, appendText: false } },
	}, {
		askClaude: { forward: { projectContext: false } },
	});
	assert.deepEqual(config.askClaude.forward, { personality: true, skills: true, appendText: false, projectContext: false });
});

test("globally forbidden full mode stays forbidden despite project overrides", (t) => {
	const config = loadFixture(t, {
		askClaude: { allowFullMode: false },
	}, {
		askClaude: { allowFullMode: true, defaultMode: "full" },
	});
	assert.equal(config.askClaude.allowFullMode, false);
	assert.notEqual(config.askClaude.defaultMode, "full");
});

test("invalid project mode cannot replace a stricter valid global default", (t) => {
	const warnings = [];
	t.mock.method(console, "error", (message) => warnings.push(message));
	const config = loadFixture(t, { askClaude: { defaultMode: "none" } }, { askClaude: { defaultMode: "typo" } });
	assert.equal(config.askClaude.defaultMode, "none");
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /invalid askClaude.defaultMode/);
});

test("validation constrains a full default when full mode is forbidden", () => {
	const warnings = [];
	const config = validateConfig({ askClaude: { defaultMode: "full", allowFullMode: false } }, (message) => warnings.push(message));
	assert.equal(config.askClaude.defaultMode, "read");
	assert.equal(config.askClaude.allowFullMode, false);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /defaultMode.*allowFullMode/);
});

test("project disabling full mode constrains a globally full default", (t) => {
	t.mock.method(console, "error", () => {});
	const config = loadFixture(t, { askClaude: { defaultMode: "full", allowFullMode: true } }, { askClaude: { allowFullMode: false } });
	assert.equal(config.askClaude.defaultMode, "read");
	assert.equal(config.askClaude.allowFullMode, false);
});
