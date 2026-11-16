import { describe, expect, test } from "bun:test";
import { whereFrom } from "../../extensions/strategium/index";
import { buildTodo } from "./todo";

const stations = `
Muster
  captain: Muster
# a comment
Scriptorium
  librarian: Plan as slices
  [seal] Plan
`;

describe("the todo of a run", () => {
	test("plain tags, one phase per station", () =>
		expect(buildTodo(stations)).toEqual([
			{
				op: "init",
				list: [
					{ phase: "Muster", items: ["[captain] Muster"] },
					{ phase: "Scriptorium", items: ["[librarian] Plan as slices", "[seal] Plan"] },
				],
			},
		]));

	test("glyph tags put the agent's glyph before its name", () => {
		const [call] = buildTodo(stations, { glyphs: true });
		expect(call.op === "init" && call.list[1].items).toEqual([
			"\u{f05da} librarian · Plan as slices",
			"\u{f047a} seal · Plan",
		]);
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
		expect(buildTodo("Scriptorium\n  librarian: Redraft slice 2", { append: true })).toEqual([
			{ op: "append", phase: "Scriptorium", items: ["[librarian] Redraft slice 2"] },
		]));

	test("mistakes are refused with their line, before the todo tool sees them", () => {
		expect(() => buildTodo("Muster\n  captian: Muster")).toThrow('line 2: unknown agent "captian"');
		expect(() => buildTodo("  captain: Muster")).toThrow("line 1: a task needs a station above it");
		expect(() => buildTodo("Muster\n  captain: Muster\n  captain: Muster")).toThrow("line 3: task");
		expect(() => buildTodo("Muster\n  captain: a\nMuster\n  captain: b")).toThrow('station "Muster" is listed twice');
		expect(() => buildTodo("Muster\nAuspex\n  scout: Map")).toThrow('station "Muster" has no tasks');
	});
});
