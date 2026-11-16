// Builds the `todo` payload of a Strategium run: one phase per station, each task tagged with its agent,
// as plain tags (`[librarian] Plan`) or Nerd Font glyph tags (`<glyph> librarian · Plan`).
//
// Usage: bun todo.ts [--glyphs] [--append] [file]   (the list comes from the file, else from stdin)
//
// The list: a station per unindented line, its tasks indented below as `agent: text` or `[agent] text`.
// Blank lines and lines starting with # are skipped.
//
//   Muster
//     captain: Muster
//   Scriptorium
//     librarian: Plan as slices → local://KEY-plan.md
//     seal: Plan
//
// Prints one JSON object per todo call: `init` for the whole list, or with --append one `append` per station.

/** The agents a task can name, with their Nerd Font glyph (codepoints checked in the Nerd Fonts glyphnames.json). */
export const AGENTS: Record<string, string> = {
	captain: "\u{f0857}", // md-chess_king
	scout: "\u{f0437}", // md-radar
	librarian: "\u{f05da}", // md-book_open_page_variant
	"battle-brother": "\u{f18be}", // md-shield_sword
	veteran: "\u{f0787}", // md-sword_cross
	apothecary: "\u{f06ef}", // md-medical_bag
	inquisitor: "\u{f029b}", // md-gavel
	"security-reviewer": "\u{f0d9a}", // md-shield_search
	sonic: "\u{f068c}", // md-skull, the servo-skull
	task: "\u{f0474}", // md-school
	seal: "\u{f047a}", // md-seal: the task waits for the user
};

type Phase = { phase: string; items: string[] };
export type TodoCall = { op: "init"; list: Phase[] } | { op: "append"; phase: string; items: string[] };

export function buildTodo(text: string, { glyphs = false, append = false } = {}): TodoCall[] {
	const list: Phase[] = [];
	const seen = new Set<string>();
	for (const [i, line] of text.split(/\r?\n/).entries()) {
		if (!line.trim() || line.trim().startsWith("#")) continue;
		const where = `line ${i + 1}`;
		if (!/^\s/.test(line)) {
			const phase = line.trim();
			if (list.some(p => p.phase === phase)) throw new Error(`${where}: station "${phase}" is listed twice`);
			list.push({ phase, items: [] });
			continue;
		}
		const m = line.match(/^\s+(?:\[([\w-]+)\]|([\w-]+):)\s*(\S.*)$/);
		if (!m) throw new Error(`${where}: a task is "agent: text" or "[agent] text"`);
		const agent = (m[1] ?? m[2]).toLowerCase();
		const task = m[3].trim();
		if (!(agent in AGENTS)) throw new Error(`${where}: unknown agent "${agent}"; one of ${Object.keys(AGENTS).join(", ")}`);
		const current = list.at(-1);
		if (!current) throw new Error(`${where}: a task needs a station above it`);
		const item = glyphs ? `${AGENTS[agent]} ${agent} · ${task}` : `[${agent}] ${task}`;
		// The todo tool refuses a task that already exists anywhere in the list.
		if (seen.has(item)) throw new Error(`${where}: task "${item}" is listed twice`);
		seen.add(item);
		current.items.push(item);
	}
	if (!list.length) throw new Error("no stations in the list");
	const empty = list.find(p => !p.items.length);
	if (empty) throw new Error(`station "${empty.phase}" has no tasks`);
	return append ? list.map(p => ({ op: "append", phase: p.phase, items: p.items })) : [{ op: "init", list }];
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const file = args.find(a => !a.startsWith("--"));
	try {
		const text = file ? await Bun.file(file).text() : await Bun.stdin.text();
		const calls = buildTodo(text, { glyphs: args.includes("--glyphs"), append: args.includes("--append") });
		for (const call of calls) console.log(JSON.stringify(call));
	} catch (err) {
		console.error(`todo: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}
