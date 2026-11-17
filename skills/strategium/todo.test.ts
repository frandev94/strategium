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

	test("mistakes are refused with their line, before the todo tool sees them", () => {
		expect(() => buildTodo("Muster\n  captian: Muster")).toThrow('line 2: unknown agent "captian"');
		expect(() => buildTodo("  captain: Muster")).toThrow("line 1: a task needs a station above it");
		expect(() => buildTodo("Muster\n  captain: Muster\n  captain: Muster")).toThrow("line 3: task");
		expect(() => buildTodo("Muster\n  captain: a\nMuster\n  captain: b")).toThrow('station "Muster" is listed twice');
		expect(() => buildTodo("Muster\nAuspex\n  scout: Map")).toThrow('station "Muster" has no tasks');
	});
});
