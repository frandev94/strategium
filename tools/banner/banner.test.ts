import { expect, test } from "bun:test";
import { ntos, Pen } from "./banner";

test("ntos rounds exact odd/4 ties half-even, like Python's %.1f", () => {
	expect(ntos(0.25)).toBe("0.2");
	expect(ntos(0.75)).toBe("0.8");
	expect(ntos(-0.25)).toBe("-0.2");
});

test("ntos trims trailing zeros and the dot", () => {
	expect(ntos(10)).toBe("10");
	expect(ntos(0.5)).toBe("0.5");
	expect(ntos(120.04)).toBe("120");
});

test("ntos keeps the sign of negative zero", () => {
	expect(ntos(-0)).toBe("-0");
});

test("ntos properties: no trailing dot or zero, error <= 0.05, odd symmetry", () => {
	for (let i = -4000; i <= 4000; i++) {
		const v = i / 8 + (i % 7) * 0.013;
		const s = ntos(v);
		expect(s).not.toMatch(/\.$/);
		expect(s).not.toMatch(/\.\d*0$/);
		expect(Math.abs(parseFloat(s) - v)).toBeLessThanOrEqual(0.05 + 1e-9);
		if (v >= 0) expect(ntos(-v)).toBe("-" + s);
	}
});

test("Pen emits H/V, skips duplicates, uses implicit L after M, and always closes with Z", () => {
	const pen = new Pen();
	pen.moveTo([0, 0]);
	pen.lineTo([5, 3]); // implicit L right after M
	pen.lineTo([5, 3]); // duplicate point: skipped
	pen.lineTo([9, 3]); // same y: H
	pen.lineTo([9, -2]); // same x: V
	pen.lineTo([1, 1]); // general: L
	pen.closePath();
	expect(pen.out.join("")).toBe("M0 0 5 3H9V-2L1 1Z");
});
