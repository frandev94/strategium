// The cockpit: a pure view of the run (boxes, seals, clock, chronicle) and its renderers. No fs, no ctx, no index.ts.
import { AGENTS } from "../../skills/strategium/todo";

export type Phase = { name: string; tasks: { content: string; status: string }[] };
export type Seal = { id: string; name: string; state: "granted" | "waiting" | "pending" };
export type Entry = { at: string; who: string; text: string; tone?: "ok" | "fail" | "seal" };
export type Note = { veteran?: true; failed?: true };
export type Depth = "truecolor" | "256";
export type Palette = Record<"gold" | "parchment" | "green" | "red" | "purple" | "iron", string>;
export type ViewInput = {
	key: string;
	untimed?: true;
	where?: { station: string; back?: true; seal?: string; task?: string };
	phases?: Phase[];
	slices?: { id: string }[];
	stopped?: { id: string }[];
	agents?: Record<string, { id: string }>;
	notes: Record<string, Note>;
	clock?: { running: boolean; el: number; bk?: number }; // bk undefined: untimed, or no booking today
	chronicle: Entry[];
	glyphs?: boolean; // Nerd Font glyphs (STRATEGIUM_GLYPHS=1) instead of plain symbols; never emoji
};
export type View = ReturnType<typeof cockpitView>;

type Kind = "active" | "done" | "failed" | "idle" | "seal";
type Tone = keyof Palette;

const HEX: Palette = { gold: "#C9A227", parchment: "#E6D8B5", green: "#4CFF7A", red: "#A4161A", purple: "#7B2CBF", iron: "#5A5A5A" };
const SEAL_TAG = /^\s*(?:\[seal\]|\u{f047a}\s*seal\s*·)\s*(.+?)\s*$/u;
const ROLE_TAG = /^\s*(?:\[([\w-]+)\]|[^\w\s[]+\s*([\w-]+)\s*·)\s*(.*?)\s*$/su;
const BAR = 14;
const RESET = "\x1b[39m";

export function colorDepth(env: Record<string, string | undefined> = process.env): Depth {
	const ct = env.COLORTERM?.toLowerCase();
	return ct === "truecolor" || ct === "24bit" || env.WT_SESSION ? "truecolor" : "256";
}

export function palette(depth: Depth): Palette {
	const fmt = depth === "truecolor" ? "ansi-16m" : "ansi-256";
	return Object.fromEntries(Object.entries(HEX).map(([k, hex]) => [k, Bun.color(hex, fmt)!])) as Palette;
}

export function sealsFrom(phases: Phase[]): Seal[] {
	const out: Seal[] = [];
	for (const t of phases.flatMap(p => p.tasks)) {
		const id = t.content.match(SEAL_TAG)?.[1];
		if (id) out.push({ id, name: id.split(/\s+/)[0], state: t.status === "completed" ? "granted" : t.status === "in_progress" ? "waiting" : "pending" });
	}
	return out;
}

/** Seals that were in `before` and not completed, and are completed in `after`. */
export function grantedSeals(before: Phase[] | undefined, after: Phase[]): Seal[] {
	if (!before) return [];
	const was = new Map(sealsFrom(before).map(s => [s.id, s.state]));
	return sealsFrom(after).filter(s => s.state === "granted" && was.has(s.id) && was.get(s.id) !== "granted");
}

export const pushEntry = (list: Entry[], e: Entry, cap = 20): Entry[] => [...list, e].slice(-cap);

export const closes = (data: string): boolean => data === "\x1b" || data === "\x1b[27u" || data === "q";

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Task jobs that are no longer running, from what the host sends to the model: a job's label is its agent id. */
export function jobEnds(messages: unknown): { id: string; status: string }[] {
	const out: { id: string; status: string }[] = [];
	for (const m of Array.isArray(messages) ? messages : []) {
		const jobs = obj(obj(m).details).jobs;
		if (!Array.isArray(jobs)) continue;
		for (const job of jobs.map(obj))
			if (job.type === "task" && job.status !== "running" && typeof job.label === "string") out.push({ id: job.label, status: String(job.status) });
	}
	return out;
}

const ROLES = [
	["librarian", "LIBRARIAN", "standing by"],
	["apothecary", "APOTHECARY", "standing by"],
	["inquisitor", "INQUISITOR", "awaiting judgement"],
] as const;

/** Role icons. A Nerd glyph carries the footer's extra space (fonts that draw it two cells wide overflow into it). */
export const icons = (nf: boolean) =>
	nf
		? { captain: `${AGENTS.captain} `, librarian: `${AGENTS.librarian}  `, apothecary: `${AGENTS.apothecary}  `, inquisitor: `${AGENTS.inquisitor}  `, brother: `${AGENTS["battle-brother"]} `, veteran: `${AGENTS.veteran} `, seal: "\u{f051f} ", back: "\u{f054c} ", sealOn: `${AGENTS.seal} `, sealWait: "\u{f051f} " }
		: { captain: "☩", librarian: "", apothecary: "", inquisitor: "", brother: "†", veteran: "‡", seal: "◷", back: "↶", sealOn: "✠", sealWait: "○" };

export function cockpitView(input: ViewInput) {
	const ic = icons(!!input.glyphs);
	const tasks = (input.phases ?? []).flatMap(p => p.tasks).map(t => ({ ...t, m: t.content.match(ROLE_TAG) }));
	const roles = ROLES.map(([role, title, idle]) => {
		// The Archmagos plans in the librarians' box.
		const mine = tasks.filter(t => ((t.m?.[1] ?? t.m?.[2])?.toLowerCase().replace("archmagos", "librarian")) === role);
		const doing = mine.find(t => t.status === "in_progress");
		const done = mine.filter(t => t.status === "completed").at(-1);
		const [kind, mark, body]: [Kind, string, string] = doing
			? ["active", "▶", doing.m![3]]
			: done
				? ["done", "✓", done.m![3]]
				: ["idle", "○", idle];
		return { title, icon: ic[role], kind, mark, text: body };
	});

	const w = input.where;
	const strat: { kind: Kind; mark: string; text: string; short: string } = w
		? w.seal
			? { kind: "seal", mark: ic.seal, text: `seal ${w.seal} awaits you`, short: `seal ${w.seal}` }
			: { kind: "active", mark: w.back ? ic.back : "▶", text: w.task ? `${w.station} › ${w.task}` : w.station, short: w.task ? `${w.station} › ${w.task}` : w.station }
		: { kind: "idle", mark: "○", text: "awaiting orders", short: "awaiting orders" };

	const ids = [...new Set([...(input.slices ?? []), ...(input.stopped ?? [])].map(s => s.id))];
	const building = new Set(Object.values(input.agents ?? {}).map(s => s.id));
	const returned = new Set((input.stopped ?? []).map(s => s.id));
	const squads = ids.map(id => {
		const note = input.notes[id] ?? {};
		const [kind, mark, text]: [Kind, string, string] = building.has(id)
			? ["active", "▶", "forging"]
			: note.failed
				? ["failed", "✗", "failed"]
				: returned.has(id)
					? ["done", "✓", "returned"]
					: ["idle", "◌", "awaiting deployment"];
		return { id, kind, mark, text, veteran: !!note.veteran };
	});

	const c = input.clock;
	const clock: { text: string; pct?: number; bar?: string; tone: Tone; paused: boolean } = { text: "⧗ …", tone: "green", paused: !!c && !c.running };
	if (c) {
		const el = Math.round(c.el);
		if (input.untimed) clock.text = `⧗ ${el} min`;
		else if (c.bk === undefined) clock.text = "⧗ awaiting today's booking";
		else {
			const raw = (c.el * 100) / c.bk;
			const fill = Math.floor((Math.min(raw, 100) * BAR) / 100);
			clock.text = `⧗ ${el}/${Math.round(c.bk)} min`;
			clock.pct = Math.round(raw);
			clock.bar = "▰".repeat(fill) + "▱".repeat(BAR - fill);
			clock.tone = raw >= 100 ? "red" : raw >= 80 ? "gold" : "green";
		}
	}

	return { key: input.key, ic, clock, seals: sealsFrom(input.phases ?? []), strat, roles, squads, chronicle: [...input.chronicle].reverse() };
}

const paint = (c: string, s: string) => c + s + RESET;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - Bun.stringWidth(s)));

/** Cut to `width` cells, keeping ANSI sequences whole and ending in `…` when something was dropped. */
function fit(line: string, width: number): string {
	if (Bun.stringWidth(line) <= width) return line;
	let out = "";
	let w = 0;
	for (const [tok] of line.matchAll(/\x1b\[[0-9;]*m|[^]/gu)) {
		const tw = tok.startsWith("\x1b") ? 0 : Bun.stringWidth(tok);
		if (w + tw > width - 1) break;
		out += tok;
		w += tw;
	}
	return `${out}…${RESET}`;
}

const kindTone: Record<Kind, Tone> = { active: "green", done: "green", failed: "red", idle: "iron", seal: "gold" };
// Marks and text of a box: green/red/iron marks, parchment text unless the state itself speaks.
const mark = (k: Kind, m: string, frame: number) => (k === "active" && m === "▶" && frame % 2 ? "▷" : m);
const markText = (k: Kind, m: string, text: string, pal: Palette, frame = 0) =>
	`${paint(pal[kindTone[k]], mark(k, m, frame))} ${paint(pal[k === "active" || k === "done" ? "parchment" : kindTone[k]], text)}`;

function sealsText(seals: Seal[], pal: Palette, names: boolean, ic: View["ic"]): string {
	if (!seals.length) return paint(pal.iron, "—");
	return seals
		.map(s => {
			const sym = s.state === "pending" ? paint(pal.iron, "○") : paint(pal.gold, s.state === "granted" ? ic.sealOn : ic.sealWait);
			return names ? `${sym} ${paint(pal.parchment, s.name)}` : sym;
		})
		.join(names ? "  " : " ");
}

function clockText(clock: View["clock"], pal: Palette, bar: boolean): string {
	const parts = [paint(pal.parchment, clock.text)];
	if (clock.pct !== undefined) {
		if (bar) parts.push(paint(pal[clock.tone], clock.bar!));
		parts.push(paint(pal[clock.tone], `${clock.pct}%`));
	}
	if (clock.paused) parts.push(paint(pal.iron, "paused"));
	return parts.join(" ");
}

const entryLine = (e: Entry, pal: Palette, who = 11) => {
	const tone: Tone = e.tone === "ok" ? "green" : e.tone === "fail" ? "red" : e.tone === "seal" ? "gold" : "parchment";
	return `${paint(pal.iron, e.at)}  ${paint(pal.parchment, pad(e.who, who))} ${paint(pal[tone], e.text)}`;
};

export function renderWidget(view: View, width: number, pal: Palette): string[] {
	const lines = [
		`${paint(pal.gold, "✠ STRATEGIUM")} · ${paint(pal.parchment, view.key)} · ${clockText(view.clock, pal, false)} · ${paint(pal.gold, "SEALS")} ${sealsText(view.seals, pal, false, view.ic)}`,
		`${view.ic.captain} ${view.strat.kind === "active" && view.strat.mark === "▶" ? "" : `${view.strat.mark} `}${view.strat.short}`,
	];
	if (view.squads.length)
		lines.push(view.squads.map(s => `${s.id} ${s.veteran ? view.ic.veteran : view.ic.brother} ${paint(pal[kindTone[s.kind]], s.mark)}`).join(" │ "));
	for (const e of view.chronicle.slice(0, 3)) lines.push(entryLine(e, pal, 8));
	return lines.map(l => fit(l, width));
}

type Box = { title: string; lines: string[]; tone: Tone; double?: boolean };

function drawBox(b: Box, w: number, pal: Palette): string[] {
	const [tl, h, tr, v, bl, br] = b.double ? "╔═╗║╚╝" : "┌─┐│└┘";
	const c = (s: string) => paint(pal[b.tone], s);
	const title = fit(b.title, w - 5).replace(`…${RESET}`, "");
	return [
		c(`${tl}${h} ${title} ${h.repeat(w - Bun.stringWidth(title) - 5)}${tr}`),
		...b.lines.map(l => `${c(v)} ${pad(fit(l, w - 4), w - 4)} ${c(v)}`),
		c(`${bl}${h.repeat(w - 2)}${br}`),
	];
}

/** `boxes` in a grid of `cols` equal columns across `inner` cells (one cell of margin each side). */
function grid(boxes: Box[], cols: number, inner: number, pal: Palette): string[] {
	const w = Math.floor((inner - 2 - (cols - 1)) / cols);
	const last = inner - 2 - (cols - 1) - w * (cols - 1); // the last column takes the remainder, so every row ends at the same cell
	const out: string[] = [];
	for (let i = 0; i < boxes.length; i += cols) {
		const row = boxes.slice(i, i + cols);
		const h = Math.max(...row.map(b => b.lines.length));
		const drawn = row.map((b, j) => drawBox({ ...b, lines: [...b.lines, ...Array(h - b.lines.length).fill("")] }, j === cols - 1 ? last : w, pal));
		for (let r = 0; r < drawn[0].length; r++) out.push(` ${drawn.map(d => d[r]).join(" ")}`);
	}
	return out;
}

export function renderCockpit(view: View, width: number, frame: number, pal: Palette): string[] {
	const roleBox = (r: View["roles"][number]): Box => ({
		title: r.icon + r.title,
		lines: [markText(r.kind, r.mark, r.text, pal, frame)],
		tone: r.title === "INQUISITOR" ? "purple" : kindTone[r.kind],
	});
	const [librarian, apothecary, inquisitor] = view.roles.map(roleBox);
	const s = view.strat;
	const strategos: Box = { title: `${view.ic.captain} STRATEGOS`, lines: [markText(s.kind, s.mark, s.text, pal, frame)], tone: "gold", double: true };
	const squads: Box[] = view.squads.map(q => ({
		title: `SQUAD ${q.id}`,
		lines: [q.veteran ? paint(pal.red, `${view.ic.veteran} VETERAN`) : paint(pal.parchment, `${view.ic.brother} brother`), markText(q.kind, q.mark, q.text, pal, frame)],
		tone: kindTone[q.kind],
	}));

	if (width < 72) {
		const one = (title: string, k: Kind, m: string, text: string) => `${paint(pal.gold, title)} ${markText(k, m, text, pal, frame)}`;
		const lines = [
			`${paint(pal.gold, "✠ STRATEGIUM")} · ${paint(pal.parchment, view.key)}`,
			clockText(view.clock, pal, false),
			`${paint(pal.gold, "SEALS")} ${sealsText(view.seals, pal, true, view.ic)}`,
			one("STRATEGOS", s.kind, s.mark, s.text),
			...view.roles.slice(0, 1).map(r => one(r.icon + r.title, r.kind, r.mark, r.text)),
			...view.squads.map(q => one(`SQUAD ${q.id}`, q.kind, q.mark, q.veteran ? `${q.text} ${view.ic.veteran}` : q.text)),
			...view.roles.slice(1).map(r => one(r.icon + r.title, r.kind, r.mark, r.text)),
			paint(pal.gold, "CHRONICLE"),
			...view.chronicle.slice(0, 8).map(e => entryLine(e, pal)),
			paint(pal.iron, "esc/q close"),
		];
		return lines.map(l => fit(l, width));
	}

	const inner = width - 2;
	const g = (t: string) => paint(pal.gold, t);
	const row = (content: string) => `${g("║")}${pad(fit(content, inner), inner)}${g("║")}`;
	const left = " " + clockText(view.clock, pal, true);
	const right = `${g("SEALS")} ${sealsText(view.seals, pal, true, view.ic)} `;
	const head = Bun.stringWidth(left) + Bun.stringWidth(right) < inner ? [row(left + " ".repeat(inner - Bun.stringWidth(left) - Bun.stringWidth(right)) + right)] : [row(left), row(` ${right}`)];

	const lead = "╔═ ✠ STRATEGIUM ── COGITATOR ";
	const key = fit(view.key, Math.max(1, width - Bun.stringWidth(lead) - 5));
	const top = `${lead}${"═".repeat(Math.max(0, width - Bun.stringWidth(lead) - Bun.stringWidth(key) - 4))} ${key} ═╗`;
	const cols = Math.max(1, Math.min(squads.length, Math.floor((inner - 1) / 27)));

	return [
		g(fit(top, width)),
		...head,
		g(`╟${"─".repeat(inner)}╢`),
		...grid([strategos, librarian], 2, inner, pal).map(row),
		...grid(squads, cols, inner, pal).map(row),
		...grid([apothecary, inquisitor], 2, inner, pal).map(row),
		g(`╟─ CHRONICLE ${"─".repeat(inner - 12)}╢`),
		...view.chronicle.slice(0, 8).map(e => row(` ${entryLine(e, pal)}`)),
		g(`╚═ esc/q close ${"═".repeat(inner - 14)}╝`),
	];
}
