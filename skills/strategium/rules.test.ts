import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { TtsrManager } from "@oh-my-pi/pi-coding-agent/export/ttsr";

const root = resolve(import.meta.dir, "../..");
const rulesDir = join(root, "rules");
const skillText = readFileSync(join(import.meta.dir, "SKILL.md"), "utf8");
const files = readdirSync(rulesDir).filter(f => f.endsWith(".md")).sort();
const names = files.map(f => f.replace(/\.md$/, ""));

const KEYS = ["description", "condition", "scope", "agents"];
const MAX_BODY = 4000;

function parseRule(file: string) {
	const text = readFileSync(join(rulesDir, file), "utf8").replace(/\r\n/g, "\n");
	const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!m) throw new Error(`${file}: no frontmatter`);
	return { fm: Bun.YAML.parse(m[1]) as Record<string, unknown>, body: m[2] };
}

/** The `rule://strategium-…` names listed in SKILL.md's `## Rules` section vs the files: what is listed without a file, and what has a file but is not listed. */
export function missingRules(skill: string, ruleFiles: string[]) {
	const section = skill.replace(/\r\n/g, "\n").match(/^## Rules\n([\s\S]*?)(?=^## |(?![\s\S]))/m)?.[1] ?? "";
	const listed = [...new Set([...section.matchAll(/rule:\/\/(strategium-[a-z-]+)/g)].map(m => m[1]))];
	const have = ruleFiles.map(f => f.replace(/\.md$/, ""));
	return { missingFiles: listed.filter(n => !have.includes(n)), unlisted: have.filter(n => !listed.includes(n)) };
}

describe("missingRules", () => {
	const skill = "## Rules\n\n- `rule://strategium-a`: x\n- `rule://strategium-b`: y\n\n## Next\n`rule://strategium-c`\n";
	test("reports a listed rule that has no file", () =>
		expect(missingRules(skill, ["strategium-a.md"])).toEqual({ missingFiles: ["strategium-b"], unlisted: [] }));
	test("reports a rule file that is not listed; names outside ## Rules do not count", () =>
		expect(missingRules(skill, ["strategium-a.md", "strategium-b.md", "strategium-c.md"])).toEqual({
			missingFiles: [],
			unlisted: ["strategium-c"],
		}));
});

describe("the run's rules", () => {
	test("SKILL.md ## Rules and rules/ list the same names", () =>
		expect(missingRules(skillText, files)).toEqual({ missingFiles: [], unlisted: [] }));

	test("every rule://strategium-stations (<Station>) in SKILL.md has a ## <Station> section in the rules file", () => {
		const stations = readFileSync(join(rulesDir, "strategium-stations.md"), "utf8");
		const sections = new Set([...stations.matchAll(/^## (.+?)\s*$/gm)].map(m => m[1]));
		const used = [...skillText.matchAll(/rule:\/\/strategium-stations`? \((\w+)\)/g)].map(m => m[1]);
		expect(used.length).toBeGreaterThan(0);
		expect(used.filter(s => !sections.has(s))).toEqual([]);
	});

	test("no rule body line of 40+ characters is repeated verbatim in SKILL.md", () => {
		const norm = (s: string) => s.replace(/^\s*- /, "").replace(/\s+/g, " ").trim();
		const skill = norm(skillText.replace(/\r\n/g, "\n"));
		const skillLines = skillText.split(/\r?\n/).map(norm);
		const repeats = files.flatMap(f =>
			parseRule(f)
				.body.split("\n")
				.map(norm)
				.filter(l => l.length >= 40 && (skillLines.includes(l) || skill.includes(l)))
				.map(l => `${f}: ${l}`),
		);
		expect(repeats).toEqual([]);
	});
});

describe("frontmatter", () => {
	for (const file of files) {
		test(`${file}: only the contract keys, main agent, plain description, run-open body, capped`, () => {
			const { fm, body } = parseRule(file);
			expect(Object.keys(fm).filter(k => !KEYS.includes(k))).toEqual([]);
			expect("alwaysApply" in fm).toBe(false);
			expect(fm.agents).toEqual(["main"]);
			expect(String(fm.description)).toStartWith("Strategium run: ");
			if (fm.condition) expect(fm.scope).toBeTruthy();
			else expect(fm.scope).toBeUndefined();
			expect(body).toContain("Strategium run is open");
			expect(body.length).toBeLessThanOrEqual(MAX_BODY);
		});
	}
});

// Samples per TTSR rule: the raw command (what `omp ttsr test` takes) and the JSON-args form the tool stream carries.
const samples: Record<string, { violations: string[]; valid: string[] }> = {
	"strategium-plan-copy": {
		violations: ["cp agent://L60 local://60-plan.md", '{"command":"cp agent://L60 local://60-plan.md"}'],
		valid: [
			"cat agent://L60 > local://60-plan.md",
			'{"command":"cat agent://L60 > local://60-plan.md"}',
			"cp README.md /tmp/x && cat agent://L60 > local://60-plan.md",
			'{"command":"cp a.txt b.txt\ncat agent://L60 > local://p.md"}',
			"ls my-cp-dir agent://x",
		],
	},
};

type Found = { name: string; path: string; content: string; alwaysApply: boolean; description?: string; condition?: string[]; scope?: string[]; agents?: string[]; provider?: string };

function discover() {
	const tmp = mkdtempSync(join(tmpdir(), "strategium-rules-"));
	try {
		const home = join(tmp, "home");
		const cwd = join(tmp, "cwd");
		const out = join(tmp, "out.json");
		for (const d of [home, cwd]) mkdirSync(d);
		const p = Bun.spawnSync(["bun", join(root, "tools/rules/discover.ts"), root, out], {
			cwd,
			env: { ...process.env, HOME: home, USERPROFILE: home },
		});
		if (p.exitCode !== 0) throw new Error(`discover.ts failed: ${p.stderr.toString()}`);
		return { home, ...(JSON.parse(readFileSync(out, "utf8")) as { childHome: string; rules: Found[] }) };
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

describe("omp discovery (claude-plugins provider, isolated HOME)", () => {
	let found: { home: string; childHome: string; rules: Found[] };
	let inRules: Found[];
	beforeAll(() => {
		found = discover();
		const prefix = (rulesDir + sep).toLowerCase();
		inRules = found.rules.filter(r => resolve(r.path).toLowerCase().startsWith(prefix));
	});

	test("the child ran with the isolated home", () => {
		expect(found.childHome).toContain("strategium-rules-");
		expect(found.childHome).toBe(found.home);
	});

	test("finds exactly the rules/*.md names, all from claude-plugins", () => {
		expect(inRules.map(r => r.name).sort()).toEqual(names);
		expect(inRules.every(r => r.provider === "claude-plugins")).toBe(true);
	});

	test("no discovered rule is always-apply; all are main-agent", () => {
		expect(inRules.filter(r => r.alwaysApply)).toEqual([]);
		expect(inRules.filter(r => r.agents?.join() !== "main")).toEqual([]);
	});

	test("every TTSR rule has samples, fires on the violations and not on the valid ones", () => {
		const ttsr = inRules.filter(r => r.condition?.length);
		expect(ttsr.length).toBeGreaterThan(0);
		for (const rule of ttsr) {
			const s = samples[rule.name];
			expect(s, `${rule.name} has no samples`).toBeDefined();
			const hit = (text: string) => {
				const mgr = new TtsrManager({ enabled: true });
				expect(mgr.addRule(rule as never)).toBe(true);
				return mgr.checkSnapshot(text, { source: "tool", toolName: "bash" }).map(r => r.name);
			};
			for (const v of s.violations) expect(hit(v), `${rule.name} on ${v}`).toEqual([rule.name]);
			for (const v of s.valid) expect(hit(v), `${rule.name} on ${v}`).toEqual([]);
		}
	});
});

describe("omp ttsr test (binary, optional)", () => {
	test.skipIf(!Bun.which("omp"))(
		"each TTSR rule triggers on its violation and not on the valid sample",
		() => {
			for (const file of files.filter(f => parseRule(f).fm.condition)) {
				const s = samples[file.replace(/\.md$/, "")];
				expect(s, `${file} has no samples`).toBeDefined();
				const run = (snippet: string) => {
					const p = Bun.spawnSync(["omp", "ttsr", "test", "--json", "--rule", join(rulesDir, file), "--source", "tool", "--tool", "bash", snippet]);
					return (JSON.parse(p.stdout.toString()).triggered as unknown[]).length;
				};
				expect(run(s.violations[0])).toBe(1);
				expect(run(s.valid[0])).toBe(0);
			}
		},
		30_000,
	);
});
