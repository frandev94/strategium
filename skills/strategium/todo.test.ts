import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { whereFrom } from "../../extensions/strategium/index";
import { buildTodo, glyphsFromEnv } from "./todo";

const stations = `
Muster
  captain: Muster
# a comment
Scriptorium
  librarian: Plan as squads
  [seal] Plan
`;

describe("the todo of a run", () => {
	test("plain tags, one phase per station", () =>
		expect(buildTodo(stations)).toEqual([
			{
				op: "init",
				list: [
					{ phase: "Muster", items: ["[captain] Muster"] },
					{ phase: "Scriptorium", items: ["[librarian] Plan as squads", "[seal] Plan"] },
				],
			},
		]));

	test("glyph tags put the agent's glyph before its name", () => {
		const [call] = buildTodo(stations, { glyphs: true });
		expect(call.op === "init" && call.list[0].items).toEqual(["\u{f18bc} captain · Muster"]);
		expect(call.op === "init" && call.list[1].items).toEqual([
			"\u{f05da} librarian · Plan as squads",
			"\u{f047a} seal · Plan",
		]);
	});

	test("glyphs come from STRATEGIUM_GLYPHS=1 only", () => {
		expect(glyphsFromEnv({ STRATEGIUM_GLYPHS: "1" })).toBe(true);
		expect(glyphsFromEnv({})).toBe(false);
		expect(glyphsFromEnv({ STRATEGIUM_GLYPHS: "0" })).toBe(false);
		for (const v of ["true", "", "2"]) expect(glyphsFromEnv({ STRATEGIUM_GLYPHS: v })).toBe(false);
	});

	describe("the CLI", () => {
		const script = `${import.meta.dir}/todo.ts`;
		const run = (glyphs: string | undefined, ...args: string[]) => {
			const env: Record<string, string | undefined> = { ...process.env };
			if (glyphs === undefined) delete env.STRATEGIUM_GLYPHS;
			else env.STRATEGIUM_GLYPHS = glyphs;
			const r = Bun.spawnSync(["bun", script, ...args], { stdin: Buffer.from("Muster\n  captain: Muster\n"), env });
			return r.stdout.toString();
		};

		test("STRATEGIUM_GLYPHS=1 prints the glyph tag", () => {
			const out = run("1");
			expect(out).toContain("\u{f18bc} captain · Muster");
			expect(out).not.toContain("[captain]");
		});

		test("unset or 0 prints the plain tag", () => {
			expect(run(undefined)).toContain("[captain] Muster");
			expect(run("0")).toContain("[captain] Muster");
		});

		test("the --glyphs flag is gone", () => expect(run(undefined, "--glyphs")).toContain("[captain] Muster"));
	});

	test("the footer recognises the seal in both kinds of tag", () => {
		for (const glyphs of [false, true]) {
			const [call] = buildTodo(stations, { glyphs });
			const list = call.op === "init" ? call.list : [];
			const phases = list.map(p => ({
				name: p.phase,
				tasks: p.items.map(content => ({ content, status: content.includes("seal") ? "in_progress" : "completed" })),
			}));
			expect(whereFrom(phases)).toEqual({ station: "Scriptorium", seal: "Plan" });
		}
	});

	test("append gives one call per station, for a return", () =>
		expect(buildTodo("Scriptorium\n  librarian: Redraft squad 2", { append: true })).toEqual([
			{ op: "append", phase: "Scriptorium", items: ["[librarian] Redraft squad 2"] },
		]));

	test("archmagos is a known agent: md-head_cog glyph tag, plain tag without glyphs", () => {
		const text = "Scriptorium\n  archmagos: Integrate the plan";
		const [plain] = buildTodo(text);
		const [glyph] = buildTodo(text, { glyphs: true });
		expect(plain.op === "init" && plain.list[0].items).toEqual(["[archmagos] Integrate the plan"]);
		expect(glyph.op === "init" && glyph.list[0].items).toEqual(["\u{f133c} archmagos · Integrate the plan"]);
		for (const call of [plain, glyph]) {
			const list = call.op === "init" ? call.list : [];
			const phases = list.map(p => ({ name: p.phase, tasks: p.items.map(content => ({ content, status: "in_progress" })) }));
			expect(whereFrom(phases)).toEqual({ station: "Scriptorium", task: "Integrate the plan" });
		}
	});

	test("confessor is a known agent: md-book_cross glyph tag, plain tag without glyphs", () => {
		const text = "Inquisition\n  confessor: Review";
		const [plain] = buildTodo(text);
		const [glyph] = buildTodo(text, { glyphs: true });
		expect(plain.op === "init" && plain.list[0].items).toEqual(["[confessor] Review"]);
		expect(glyph.op === "init" && glyph.list[0].items).toEqual(["\u{f00a2} confessor · Review"]);
		for (const call of [plain, glyph]) {
			const list = call.op === "init" ? call.list : [];
			const phases = list.map(p => ({ name: p.phase, tasks: p.items.map(content => ({ content, status: "in_progress" })) }));
			expect(whereFrom(phases)).toEqual({ station: "Inquisition", task: "Review" });
		}
	});

	test("mistakes are refused with their line, before the todo tool sees them", () => {
		expect(() => buildTodo("Muster\n  captian: Muster")).toThrow('line 2: unknown agent "captian"');
		expect(() => buildTodo("  captain: Muster")).toThrow("line 1: a task needs a station above it");
		expect(() => buildTodo("Muster\n  captain: Muster\n  captain: Muster")).toThrow("line 3: task");
		expect(() => buildTodo("Muster\n  captain: a\nMuster\n  captain: b")).toThrow('station "Muster" is listed twice');
		expect(() => buildTodo("Muster\nAuspex\n  scout: Map")).toThrow('station "Muster" has no tasks');
	});
});

test("the skill's todo example builds without errors", async () => {
	const skill = await Bun.file(`${import.meta.dir}/SKILL.md`).text();
	const m = skill.replace(/\r\n/g, "\n").match(/\n( *)bun [^\n]*todo\.ts" <<'EOF'\n([\s\S]*?)\n\1EOF/);
	expect(m).not.toBeNull();
	const example = m![2].split("\n").map(l => l.slice(m![1].length)).join("\n");
	const [call] = buildTodo(example);
	expect(call.op === "init" && call.list.map(p => p.phase)).toEqual([
		"Muster",
		"Auspex",
		"Scriptorium",
		"Deployment",
		"Skirmish",
		"Inquisition",
		"Extraction",
		"Debrief",
	]);
	expect(call.op === "init" && call.list[0].items).toEqual(["[captain] Objective", "[captain] Orders"]);
});

describe("station filters", () => {
	const five = "A\n  captain: a\nB\n  captain: b\nC\n  captain: c\nD\n  captain: d\n";
	const phases = (o: Parameters<typeof buildTodo>[1]) => {
		const [call] = buildTodo(five, o);
		return call.op === "init" ? call.list : [];
	};
	const names = (o: Parameters<typeof buildTodo>[1]) => phases(o).map(p => p.phase);

	test("to keeps that station and the ones before it", () => expect(names({ to: "B" })).toEqual(["A", "B"]));
	test("from keeps that station and the ones after it", () => expect(names({ from: "C" })).toEqual(["C", "D"]));
	test("from and to together keep a contiguous slice", () => expect(names({ from: "B", to: "C" })).toEqual(["B", "C"]));

	test("to S followed by from the next station give the whole list, same items", () => {
		const all = phases({});
		for (const [i, p] of all.entries()) {
			if (i === all.length - 1) continue;
			expect([...phases({ to: p.phase }), ...phases({ from: all[i + 1].phase })]).toEqual(all);
		}
	});

	test("append with to drops the later stations", () =>
		expect(buildTodo("Scriptorium\n  seal: Plan\nExtraction\n  seal: MR\n", { append: true, to: "Scriptorium" })).toEqual([
			{ op: "append", phase: "Scriptorium", items: ["[seal] Plan"] },
		]));

	test("an unknown station is refused", () => {
		expect(() => buildTodo(five, { from: "X" })).toThrow('station "X" is not in the list');
		expect(() => buildTodo(five, { to: "X" })).toThrow('station "X" is not in the list');
	});

	test("from after to leaves nothing", () => expect(() => buildTodo(five, { from: "D", to: "A" })).toThrow("no stations in the list"));

	test("validation still covers the stations a filter drops", () =>
		expect(() => buildTodo("A\n  captain: a\nB\n", { to: "A" })).toThrow('station "B" has no tasks'));

	test("the CLI reads the file after --from and prints only those stations", async () => {
		const dir = mkdtempSync(join(tmpdir(), "st-todo-"));
		const file = join(dir, "list.txt");
		await Bun.write(file, five);
		try {
			const r = Bun.spawnSync(["bun", `${import.meta.dir}/todo.ts`, "--from", "C", file]);
			const call = JSON.parse(r.stdout.toString());
			expect(call.list.map((p: { phase: string }) => p.phase)).toEqual(["C", "D"]);
		} finally {
			rmSync(dir, { recursive: true });
		}
	});

	test.each(["from", "to"])("the CLI refuses --%s without a station", flag => {
		const r = Bun.spawnSync(["bun", `${import.meta.dir}/todo.ts`, `--${flag}`], { stdin: Buffer.from(five) });
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain(`--${flag} needs a station`);
	});

	test.each(["from", "to"])("the CLI treats --%s followed by another flag as missing its station", flag => {
		const r = Bun.spawnSync(["bun", `${import.meta.dir}/todo.ts`, `--${flag}`, "--append"], { stdin: Buffer.from(five) });
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain(`--${flag} needs a station`);
	});

	test("SKILL.md's skeleton splits into plan stations and the rest", async () => {
		const skill = await Bun.file(`${import.meta.dir}/SKILL.md`).text();
		const m = skill.replace(/\r\n/g, "\n").match(/\n( *)bun [^\n]*todo\.ts" <<'EOF'\n([\s\S]*?)\n\1EOF/);
		const example = m![2].split("\n").map(l => l.slice(m![1].length)).join("\n");
		const list = (o: Parameters<typeof buildTodo>[1]) => {
			const [call] = buildTodo(example, o);
			return call.op === "init" ? call.list.map(p => p.phase) : [];
		};
		expect(list({ to: "Scriptorium" })).toEqual(["Muster", "Auspex", "Scriptorium"]);
		expect(list({ from: "Deployment" })).toEqual(["Deployment", "Skirmish", "Inquisition", "Extraction", "Debrief"]);
	});
});
