// Child of skills/strategium/rules.test.ts: discovers the plugin's rules through omp's claude-plugins provider
// (the loader marketplace installs use, fed the way --plugin-dir feeds it). Run with an isolated HOME/USERPROFILE.
// usage: bun tools/rules/discover.ts <plugin-root> <out.json>
import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import "@oh-my-pi/pi-coding-agent/discovery";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { injectPluginDirRoots } from "@oh-my-pi/pi-coding-agent/discovery/helpers";

const [root, out] = process.argv.slice(2);
if (!root || !out) throw new Error("usage: discover.ts <plugin-root> <out.json>");
await injectPluginDirRoots(homedir(), [root], process.cwd());
const { items } = await loadCapability(ruleCapability.id, { cwd: process.cwd(), providers: ["claude-plugins"] });
// Rules are JSON-safe except the compiled condition; keep the fields the test checks.
writeFileSync(
	out,
	JSON.stringify({
		childHome: homedir(),
		rules: (items as any[]).map(r => ({
			name: r.name, path: r.path, content: r.content, alwaysApply: r.alwaysApply,
			description: r.description, condition: r.condition, scope: r.scope, agents: r.agents,
			provider: r._source?.provider,
		})),
	}),
);
