import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const dir = join(resolve(import.meta.dir, "../.."), "agents");
const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();

describe("agents/*.md frontmatter", () => {
	test("there are agent files", () => expect(files.length).toBeGreaterThan(0));
	for (const f of files) {
		test(`${f}: frontmatter parses with one description value`, () => {
			const raw = readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");
			const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
			expect(m).not.toBeNull();
			const fm = Bun.YAML.parse(m![1]) as Record<string, unknown>;
			expect(fm.name).toBe(f.replace(/\.md$/, ""));
			const d = fm.description;
			expect(typeof d).toBe("string");
			expect((d as string).length).toBeGreaterThan(0);
			expect(d).not.toMatch(/[\r\n]/);
			const lines = m![1].split("\n");
			const i = lines.findIndex(l => l.startsWith("description:"));
			expect(i).toBeGreaterThanOrEqual(0);
			// no continuation line under the description
			expect(lines[i + 1] ?? "key:").not.toMatch(/^\s/);
			// omp's strict parser rejects ": " in an unquoted value
			const value = lines[i].slice("description:".length).trim();
			if (!/^["']/.test(value)) expect(value).not.toContain(": ");
		});
	}
});
