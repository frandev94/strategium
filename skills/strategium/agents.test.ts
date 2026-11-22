import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";

const dir = join(resolve(import.meta.dir, "../.."), "agents");
const files = readdirSync(dir).filter(f => f.endsWith(".md")).sort();

describe("agents/*.md frontmatter", () => {
	test("there are agent files", () => expect(files.length).toBeGreaterThan(0));
	for (const f of files) {
		test(`${f}: name matches the file and description is one clean line`, () => {
			const raw = readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n");
			const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
			expect(m).not.toBeNull();
			const fm = Bun.YAML.parse(m![1]) as Record<string, unknown>;
			expect(fm.name).toBe(f.replace(/\.md$/, ""));
			const d = fm.description;
			expect(typeof d).toBe("string");
			expect((d as string).length).toBeGreaterThan(0);
			expect(d).not.toMatch(/[\r\n]/);
			// the description line itself must carry no stray CR and no ": " (omp's strict parser rejects it)
			const line = m![1].split("\n").find(l => l.startsWith("description:"))!;
			expect(line).not.toContain("\r");
			expect(line.slice("description:".length)).not.toContain(": ");
			expect(Object.keys(fm).sort()).toContain("description");
		});
	}
});
