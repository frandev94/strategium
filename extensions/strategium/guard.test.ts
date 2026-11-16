import { describe, expect, test } from "bun:test";
import { editTargets } from "./index";

// The edit tool has five wire contracts; the guard must see the file in every one of them,
// or the Captain edits the repository it is not allowed to touch.
describe("files a tool call would write", () => {
	test("hashline headers", () => {
		const input = { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x\n[src/b.ts#C3D4]\nPUT 1*:\n+y" };
		expect(editTargets("edit", input)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("replace and patch take a path", () => {
		expect(editTargets("edit", { path: "src/a.ts", old_string: "a", new_string: "b" })).toEqual(["src/a.ts"]);
		expect(editTargets("edit", { path: "src/a.ts", edits: [{ op: "update" }] })).toEqual(["src/a.ts"]);
	});

	test("apply_patch sections, including the move destination", () => {
		const input = {
			input: [
				"*** Begin Patch",
				"*** Add File: src/new.ts",
				"+x",
				"*** Update File: src/old.ts",
				"*** Move to: src/moved.ts",
				"@@",
				"-a",
				"+b",
				"*** Delete File: src/gone.ts",
				"*** End Patch",
			].join("\n"),
		};
		expect(editTargets("edit", input)).toEqual(["src/new.ts", "src/old.ts", "src/gone.ts", "src/moved.ts"]);
	});

	test("the apply_patch custom tool is the edit tool under another name", () => {
		const input = { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" };
		expect(editTargets("apply_patch", input)).toEqual(["src/a.ts"]);
	});

	test("sloppy edit sections", () => {
		const input = { input: "*** Edit File: src/a.ts\n*** Find\na\n*** Replace\nb" };
		expect(editTargets("edit", input)).toEqual(["src/a.ts"]);
	});

	test("write takes a path and other tools write nothing", () => {
		expect(editTargets("write", { path: "src/a.ts", content: "x" })).toEqual(["src/a.ts"]);
		expect(editTargets("read", { path: "src/a.ts" })).toEqual([]);
		expect(editTargets("edit", {})).toEqual([]);
	});
});
