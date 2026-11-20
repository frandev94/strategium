import { describe, expect, test } from "bun:test";
import { missingRoles } from "./roles";

const set = { plan: "a", slow: "b", task: "c" };

describe("missingRoles", () => {
	test("all three set", () => expect(missingRoles(set)).toEqual([]));

	test("empty map warns for plan, slow, task in order", () => {
		const w = missingRoles({});
		expect(w).toHaveLength(3);
		expect(w[0]).toContain("modelRoles.plan");
		expect(w[1]).toContain("modelRoles.slow");
		expect(w[2]).toContain("modelRoles.task");
	});

	test("empty and blank strings count as unset", () =>
		expect(missingRoles({ plan: "", slow: "", task: "  " })).toHaveLength(3));

	test("non-object input counts as empty", () => {
		expect(missingRoles(undefined)).toHaveLength(3);
		expect(missingRoles("x")).toHaveLength(3);
	});

	test("slow missing gives exactly one line naming the inquisitor", () => {
		const w = missingRoles({ plan: "x", task: "y" });
		expect(w).toEqual([
			"WARN modelRoles.slow is unset: inquisitor run on the configured default, or on omp's slow list (the costliest model) when default is unset too. Set it in modelRoles (README, \"Models\").",
		]);
	});

	test("plan line text", () =>
		expect(missingRoles({ slow: "b", task: "c" })).toEqual([
			"WARN modelRoles.plan is unset: librarian and archmagos run on the session's model. Set it in modelRoles (README, \"Models\").",
		]));
});
