// The cockpit: a pure view of the run (boxes, seals, clock, chronicle) and its renderers. No fs, no ctx, no index.ts.
import { AGENTS } from "../../skills/strategium/todo";

export type Phase = { name: string; tasks: { content: string; status: string }[] };
export type Seal = { id: string; name: string; state: "granted" | "waiting" | "pending" };
export type Entry = { at: string; who: string; text: string; tone?: "ok" | "fail" | "seal" };
export type Note = { veteran?: true; failed?: true };
// shortcut: agents are tied to the phase index at spawn; a todo rebuilt in another order misplaces them; upgrade with a stable station id in the todo.
export type Deployed = { who: string; role: string; squad?: string; station: number; state: "active" | "done" | "failed" };
export type Depth = "truecolor" | "256";
export type Palette = Record<"gold" | "parchment" | "green" | "red" | "purple" | "iron", string>;
export type ViewInput = {
	key: string;
	untimed?: true;
	deployed?: Map<string, Deployed>; // agent id (or eval-<role>-<n>) → what the host deployed, kept by index.ts
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

type Kind = "active" | "done" | "failed" | "idle";
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

/** The phase the run is at, by index: the first with a task running, else the first with a task waiting, else the last. -1 with no phases. */
export function activePhase(phases: Phase[]): number {
	const first = (status: string) => phases.findIndex(p => p.tasks.some(t => t.status === status));
	const doing = first("in_progress");
	if (doing >= 0) return doing;
	const waiting = first("pending");
	return waiting >= 0 ? waiting : phases.length - 1;
}

type BoxDef = { title: string; tags: string[]; icon: keyof ReturnType<typeof icons>; tone?: Tone };
// One box per agent type, in this order; `tags` are the todo tags and agent names it takes (the Archmagos plans with the librarians).
const BOXES: BoxDef[] = [
	{ title: "CAPTAIN", tags: ["captain"], icon: "captain", tone: "gold" },
	{ title: "SCOUTS", tags: ["scout"], icon: "scout" },
	{ title: "LIBRARIANS", tags: ["librarian", "archmagos"], icon: "librarian" },
	{ title: "BATTLE-BROTHERS", tags: ["battle-brother", "veteran"], icon: "brother" },
	{ title: "APOTHECARIES", tags: ["apothecary"], icon: "apothecary" },
	{ title: "INQUISITOR", tags: ["inquisitor"], icon: "inquisitor", tone: "purple" },
	{ title: "SECURITY-REVIEWER", tags: ["security-reviewer"], icon: "securityReviewer" },
	{ title: "SONIC", tags: ["sonic"], icon: "sonic" },
	{ title: "ADEPTS", tags: ["task"], icon: "task" },
	{ title: "SEAL", tags: ["seal"], icon: "sealOn", tone: "gold" },
];

/** Agent icons. A Nerd glyph carries one trailing space; `label` adds the gap, so fonts that draw it two cells wide overflow into it. */
export const icons = (nf: boolean) =>
	nf
		? {
				captain: `${AGENTS.captain} `,
				scout: `${AGENTS.scout} `,
				librarian: `${AGENTS.librarian} `,
				brother: `${AGENTS["battle-brother"]} `,
				veteran: `${AGENTS.veteran} `,
				apothecary: `${AGENTS.apothecary} `,
				inquisitor: `${AGENTS.inquisitor} `,
				securityReviewer: `${AGENTS["security-reviewer"]} `,
				sonic: `${AGENTS.sonic} `,
				task: `${AGENTS.task} `,
				seal: "\u{f051f} ",
				back: "\u{f054c} ",
				sealOn: `${AGENTS.seal} `,
				sealWait: "\u{f051f} ",
			}
		: { captain: "☩", scout: "", librarian: "", brother: "†", veteran: "‡", apothecary: "", inquisitor: "", securityReviewer: "", sonic: "", task: "", seal: "◷", back: "↶", sealOn: "✠", sealWait: "○" };

/** `icon` then `text`, one gap between them. No icon: just the text. */
const label = (icon: string, text: string) => (icon ? `${icon} ${text}` : text);

const ROLE_LINE: Record<string, Kind> = { in_progress: "active", completed: "done", pending: "idle" };
const MARK: Record<Kind, string> = { active: "▶", done: "✓", failed: "✗", idle: "○" };

export function cockpitView(input: ViewInput) {
	const ic = icons(!!input.glyphs);
	const phases = input.phases ?? [];
	const at = activePhase(phases);
	const phase = phases.at(at); // at is -1 with no phases: undefined

	const doing = phase?.tasks.find(t => t.status === "in_progress");
	const sealName = doing && sealsFrom([{ name: phase!.name, tasks: [doing] }])[0]?.name;
	const back = !!doing && phases.slice(at + 1).some(p => p.tasks.some(t => t.status === "completed"));
	const station: { kind: Kind; mark: string; name: string; note?: string } = !phase
		? { kind: "idle", mark: "○", name: "awaiting orders" }
		: { kind: doing ? "active" : "idle", mark: doing ? (back ? ic.back : "▶") : "○", name: phase.name, ...(sealName ? { note: label(ic.seal, `seal ${sealName} awaits you`) } : {}) };

	const ids = [...new Set([...(input.slices ?? []), ...(input.stopped ?? [])].map(s => s.id))];
	const building = new Set(Object.values(input.agents ?? {}).map(s => s.id));
	const returned = new Set((input.stopped ?? []).map(s => s.id));
	// shortcut: a squad's veteran mark comes from in-memory notes, lost on restart; [veteran] todo tasks still show ‡.
	const squads = ids.map(id => {
		const note = input.notes[id] ?? {};
		const [kind, state]: [Kind, string] = building.has(id)
			? ["active", "forging"]
			: note.failed
				? ["failed", "failed"]
				: returned.has(id)
					? ["done", "returned"]
					: ["idle", "awaiting deployment"];
		return { kind, mark: MARK[kind], text: label(note.veteran ? ic.veteran : ic.brother, `squad ${id} ${state}`) };
	});

	const tasks = (phase?.tasks ?? []).flatMap(t => {
		const m = t.content.match(ROLE_TAG);
		return m ? [{ status: t.status, role: (m[1] ?? m[2]).toLowerCase(), text: m[3] }] : [];
	});
	const seen = phase ? [...(input.deployed ?? [])].filter(([, d]) => d.station === at) : []; // no phases: no station, so no boxes
	const boxes = BOXES.flatMap(def => {
		const mine = tasks.filter(t => def.tags.includes(t.role));
		const agents = seen.filter(([, d]) => def.tags.includes(d.role));
		if (!mine.length && !agents.length) return [];
		const brothers = def.tags.includes("battle-brother");
		// In the brothers' box every line carries the icon of its own rank.
		const who = (role: string, text: string) => (brothers ? label(role === "veteran" ? ic.veteran : ic.brother, text) : text);
		const lines = [
			...mine.map(t => {
				const kind = ROLE_LINE[t.status] ?? "failed";
				return { kind, mark: MARK[kind], text: who(t.role, t.text) };
			}),
			...(brothers ? squads : []),
			...agents.filter(([, d]) => !d.squad).map(([id, d]) => ({ kind: d.state, mark: MARK[d.state], text: who(d.role, id) })),
		];
		const tone = def.tone ?? (lines.some(l => l.kind === "failed") ? "red" : lines.some(l => l.kind !== "idle") ? "green" : "iron");
		return [{ title: label(ic[def.icon], def.title), tone, lines }];
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

	return { key: input.key, ic, clock, seals: sealsFrom(phases), station, boxes, chronicle: [...input.chronicle].reverse() };
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

const kindTone: Record<Kind, Tone> = { active: "green", done: "green", failed: "red", idle: "iron" };
// Marks and text of a box: green/red/iron marks, parchment text unless the state itself speaks.
const mark = (k: Kind, m: string, frame: number) => (k === "active" && m === "▶" && frame % 2 ? "▷" : m);
const markText = (k: Kind, m: string, text: string, pal: Palette, frame = 0) =>
	`${paint(pal[kindTone[k]], mark(k, m, frame))} ${paint(pal[k === "active" || k === "done" ? "parchment" : kindTone[k]], text)}`;

function sealsText(seals: Seal[], pal: Palette, ic: View["ic"]): string {
	if (!seals.length) return paint(pal.iron, "—");
	return seals
		.map(s => {
			const sym = s.state === "pending" ? paint(pal.iron, "○") : paint(pal.gold, s.state === "granted" ? ic.sealOn : ic.sealWait);
			return `${sym} ${paint(pal.parchment, s.name)}`;
		})
		.join("  ");
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

const entryLine = (e: Entry, pal: Palette) => {
	const tone: Tone = e.tone === "ok" ? "green" : e.tone === "fail" ? "red" : e.tone === "seal" ? "gold" : "parchment";
	return `${paint(pal.iron, e.at)}  ${paint(pal.parchment, pad(e.who, 11))} ${paint(pal[tone], e.text)}`;
};

type Box = { title: string; lines: string[]; tone: Tone };

function drawBox(b: Box, w: number, pal: Palette): string[] {
	const [tl, h, tr, v, bl, br] = "┌─┐│└┘";
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
	const s = view.station;
	const station = markText(s.kind, s.mark, s.name, pal, frame) + (s.note ? ` · ${paint(pal.gold, s.note)}` : "");
	// shortcut: no line cap per box; a station with many tasks pushes the chronicle down; cap lines when a real run hits it.
	const boxes: Box[] = view.boxes.map(b => ({ title: b.title, lines: b.lines.map(l => markText(l.kind, l.mark, l.text, pal, frame)), tone: b.tone }));

	if (width < 72) {
		const lines = [
			`${paint(pal.gold, "✠ STRATEGIUM")} · ${paint(pal.parchment, view.key)}`,
			clockText(view.clock, pal, false),
			`${paint(pal.gold, "SEALS")} ${sealsText(view.seals, pal, view.ic)}`,
			station,
			...boxes.flatMap(b => [paint(pal.gold, b.title), ...b.lines.map(l => `  ${l}`)]),
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
	const right = `${g("SEALS")} ${sealsText(view.seals, pal, view.ic)} `;
	const head = Bun.stringWidth(left) + Bun.stringWidth(right) < inner ? [row(left + " ".repeat(inner - Bun.stringWidth(left) - Bun.stringWidth(right)) + right)] : [row(left), row(` ${right}`)];

	const lead = "╔═ ✠ STRATEGIUM ── COGITATOR ";
	const key = fit(view.key, Math.max(1, width - Bun.stringWidth(lead) - 5));
	const top = `${lead}${"═".repeat(Math.max(0, width - Bun.stringWidth(lead) - Bun.stringWidth(key) - 4))} ${key} ═╗`;
	const title = fit(station, inner - 4); // keeps at least one cell of rule
	const cols = Math.max(1, Math.min(boxes.length, Math.floor((inner - 1) / 27)));

	return [
		g(fit(top, width)),
		...head,
		`${g("╟─ ")}${title}${g(` ${"─".repeat(inner - 3 - Bun.stringWidth(title))}╢`)}`,
		...grid(boxes, cols, inner, pal).map(row),
		g(`╟─ CHRONICLE ${"─".repeat(inner - 12)}╢`),
		...view.chronicle.slice(0, 8).map(e => row(` ${entryLine(e, pal)}`)),
		g(`╚═ esc/q close ${"═".repeat(inner - 14)}╝`),
	];
}
