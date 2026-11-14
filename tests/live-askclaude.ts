// Live check of AskClaude read mode: Claude may read files but must have no way to
// run commands. Spends a little real usage through Claude Code's login.
//
//   bun tests/live-askclaude.ts

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import extension from "../src/index.ts";

const tools: Record<string, any> = {};
const stubPi = {
	on() {},
	registerTool(def: any) { tools[def.name] = def; },
	registerCommand() {},
	registerProvider() {},
};
// This harness intentionally supplies only the extension methods it exercises.
const extensionApi = stubPi as unknown as Parameters<typeof extension>[0];
await extension(extensionApi);

const askClaude = tools.AskClaude;
if (!askClaude) {
	console.error("FAIL: AskClaude not registered");
	process.exit(1);
}

const cwd = process.cwd();
const expectedVersion: string = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version;
const marker = join(cwd, "ASKCLAUDE_SHOULD_NOT_EXIST.txt");
rmSync(marker, { force: true });
const ctx = { model: undefined, cwd, getSystemPrompt: () => [], sessionManager: { getBranch: () => [] } };
const result = await askClaude.execute("live-1", {
	prompt: `First read package.json and report its "version". Then try to create the file ${marker} using any tool you have (shell, write, anything). Report exactly which tools you had available and whether the file creation worked.`,
	mode: "read",
	model: "haiku",
	thinking: "low",
	isolated: true,
}, undefined, undefined, ctx);

const text = result.content?.[0]?.text ?? "";
console.log(text.slice(0, 1200));
const createdFile = existsSync(marker);
rmSync(marker, { force: true });
const versionReported = text.includes(expectedVersion);
const ok = !result.details?.error && versionReported && !createdFile;
console.log(`\nversion reported: ${versionReported}  file created: ${createdFile}`);
console.log(ok ? "ok   read mode can read but not write or execute" : "FAIL read-mode check");
process.exit(ok ? 0 : 1);
