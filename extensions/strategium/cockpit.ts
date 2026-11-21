// The cockpit: a pure view of the run (boxes, seals, clock, chronicle) and its renderers. No fs, no ctx, no index.ts.
import { AGENTS } from "../../skills/strategium/todo";
import { DEFAULT_THEME, THEMES, type Theme, type Tone } from "./themes";

export type Phase = { name: string; tasks: { content: string; status: string }[] };
export type Seal = { id: string; state: "granted" | "waiting" | "pending" };
export type Entry = { at: string; who: string; text: string; tone?: "ok" | "fail" | "seal" | "warn" };
export type Note = { veteran?: true; failed?: true };
export type Deployed = { who: string; role: string; squad?: string; station?: string; state: "active" | "done" | "failed"; at?: number; stalled?: number; blocked?: true }; // station: its name at spawn; undefined with no phases. at: deploy time in ms. stalled: the live entry's `at` (the idle start) the reader marked stalled. blocked: its row said so and the alarm rang for it; cleared when the row stops saying it
/** What a child writes about itself, already validated by the reader (contract v3): ms timestamps, its todo counts, its last tool call and what it signalled (pct, eta_min, line, blocked), and its usage. Usage is optional and absent means unknown, never 0: cost is USD (finite, >= 0) as omp prices it, its own spend without nested subagents; the tokens are safe integers >= 0. */
export type Live = { since: number; at: number; tool?: string; intent?: string; done?: number; total?: number; current?: string; pct?: number; eta_min?: number; line?: string; blocked?: boolean; cost?: number; tokens_in?: number; tokens_out?: number; cache_read?: number; cache_write?: number };
export type Depth = "truecolor" | "256";
type Ansi = `\x1b[${string}`; // an escape sequence, not a hex: keeps a Theme out of renderCockpit
export type Palette = Record<Tone, Ansi> & { bg?: Ansi }; // a foreground sequence per tone, bg a background one
export type Nav = { cursor?: { id: string; at: number }; shown?: { phase: number; from: number }; tops?: Record<string, number> }; // cursor: the selected line by identity and its position; shown: a browsed station and the active one it was taken at; tops: the first line a windowed box shows, by box title (renderCockpit writes it, as only it knows the room). In memory only (see cockpitView)
export type ViewInput = {
	nav?: Nav;
	key: string;
	untimed?: true;
	deployed?: Map<string, Deployed>; // agent id (eval-<role>-<n> for an eval spawn without spawnKey) → what the host deployed, kept by index.ts
	phases?: Phase[];
	slices?: { id: string }[];
	stopped?: { id: string }[];
	agents?: Record<string, { id: string }>;
	notes: Record<string, Note>;
	clock?: { running: boolean; el: number; bk?: number }; // bk undefined: untimed, or no booking today
	chronicle: Entry[];
	seal?: { id: string; lines: string[] }; // what the Captain prepared for the seal that waits (the `seal` action); shown only while that seal waits
	glyphs?: boolean; // Nerd Font glyphs (STRATEGIUM_GLYPHS=1) instead of plain symbols; never emoji
	status?: "working" | "awaiting"; // what the main agent is doing: a turn runs, or the prompt is free for the user's orders
	live?: Map<string, Live>; // agent id → what that agent last wrote about itself; text in it is untrusted
	now?: number; // ms; the elapsed time of a live row counts to it. No now, no live rows
};
export type View = ReturnType<typeof cockpitView>;

type Kind = "active" | "done" | "failed" | "idle";
type Line = { id: string; kind: Kind; mark: string; text: string; detail?: string; stalled?: true }; // id: the line's identity for the cursor; detail: its own row under the line

/** Agent text as one printable line: ANSI sequences stripped, then control and bidi characters and whitespace runs as single spaces. */
export const oneLine = (s: unknown) => (typeof s === "string" ? clean(Bun.stripANSI(s)).replace(/\s+/g, " ").trim() : "");
const span = (min: number) => (min < 1 ? "<1m" : min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`);
const minutes = (ms: number) => Math.floor(Math.max(0, ms) / 60_000);
/** The one money formatter: dollars and cents, rounded once. */
export const usd = (n: number) => `$${n.toFixed(2)}`;
/** A cost worth showing: finite, not negative and under a sane cap (a huge value would break the report's bars). */
export const isCost = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e6;

/** The row under an active agent's line: `[blocked · ][stalled Nm · ]elapsed · cost[ · progress][ · eta][ · text]`. Cost is `$x.xx`, or `$?` while the agent's usage is unknown. Progress is the agent's `pct%` else `done/total`; eta its `~eta_min` else the one computed from the todo; text its `line`, else the todo's current task, else the intent (else tool). `stalled` is the live entry's `at` (the idle start) the reader marked stalled. A blocked row draws gold like a stalled one. */
function liveRow(d: Deployed, live: Live | undefined, now: number | undefined): Pick<Line, "detail" | "stalled"> {
	const from = d.at ?? live?.since;
	if (d.state !== "active" || from === undefined || now === undefined) return {};
	const ms = Math.max(0, now - from);
	const parts = [span(minutes(ms)), isCost(live?.cost) ? usd(live.cost) : "$?"];
	const { done = 0, total = 0, pct, eta_min } = live ?? {};
	const todo = Number.isInteger(done) && Number.isInteger(total) && total > 0 && done >= 0 && done <= total;
	const has = (n: number | undefined, max: number): n is number => Number.isInteger(n) && n! >= 0 && n! <= max;
	if (has(pct, 100)) parts.push(`${pct}%`);
	else if (todo) parts.push(`${done}/${total}`);
	if (has(eta_min, 10080)) parts.push(`~${span(eta_min)}`);
	else if (todo && done > 0 && done < total) parts.push(`~${span(Math.max(1, Math.ceil((ms * (total - done)) / done / 60_000)))}`);
	parts.push(oneLine(live?.line) || (todo ? oneLine(live?.current) : oneLine(live?.intent) || oneLine(live?.tool)));
	const start = live?.at ?? 0; // the same idle start index.ts marks
	const stalled = start > 0 && d.stalled === start;
	const blocked = live?.blocked === true;
	return { detail: `${blocked ? "blocked · " : ""}${stalled ? `stalled ${minutes(now - start)}m · ` : ""}${parts.filter(Boolean).join(" · ")}`, ...(stalled || blocked ? { stalled: true as const } : {}) };
}

const BG_RESET = "\x1b[49m";
const SEAL_TAG = /^\s*(?:\[seal\]|\u{f047a}\s*seal\s*·)\s*(.+?)\s*$/u;
const ROLE_TAG = /^\s*(?:\[([\w-]+)\]|[^\w\s[]+\s*([\w-]+)\s*·)\s*(.*?)\s*$/su;
const BAR = 14;
const BOX_CAP = 8; // most lines a box shows
const CHRONICLE_MIN = 5; // chronicle rows a height keeps before the boxes give up lines
const RESET = "\x1b[39m";

export function colorDepth(env: Record<string, string | undefined> = process.env): Depth {
	const ct = env.COLORTERM?.toLowerCase();
	return ct === "truecolor" || ct === "24bit" || env.WT_SESSION ? "truecolor" : "256";
}

/** The theme's colours as ANSI sequences at `depth`; bg turns Bun.color's foreground sequence into a background one. */
export function palette(depth: Depth, theme: Theme = THEMES[DEFAULT_THEME]): Palette {
	const fmt = depth === "truecolor" ? "ansi-16m" : "ansi-256";
	const { bg, ...tones } = theme;
	const pal = Object.fromEntries(Object.entries(tones).map(([k, hex]) => [k, Bun.color(hex, fmt)!])) as Palette;
	return bg ? { ...pal, bg: Bun.color(bg, fmt)!.replace("[38;", "[48;") as Ansi } : pal;
}

/** Text from the model or a file, made safe to print: control characters (ESC, TAB, CR, LF, DEL, C1), bidi overrides and line/paragraph separators become spaces. */
export const clean = (s: string) => s.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069\u2028\u2029\u200e\u200f\u061c]/gu, " ");

export function sealsFrom(phases: Phase[]): Seal[] {
	const out: Seal[] = [];
	for (const t of phases.flatMap(p => p.tasks)) {
		const id = t.content.match(SEAL_TAG)?.[1];
		if (id) out.push({ id, state: t.status === "completed" ? "granted" : t.status === "in_progress" ? "waiting" : "pending" });
	}
	return out;
}

/** The seal that waits for the user: the first in_progress task of the first phase that has one, if it is a seal. */
export const waitingSeal = (phases: Phase[]): Seal | undefined => {
	const task = phases.find(p => p.tasks.some(t => t.status === "in_progress"))?.tasks.find(t => t.status === "in_progress");
	return task && sealsFrom([{ name: "", tasks: [task] }])[0];
};

/** Seals that were in `before` and not completed, and are completed in `after`. */
export function grantedSeals(before: Phase[] | undefined, after: Phase[]): Seal[] {
	if (!before) return [];
	const was = new Map(sealsFrom(before).map(s => [s.id, s.state]));
	return sealsFrom(after).filter(s => s.state === "granted" && was.has(s.id) && was.get(s.id) !== "granted");
}

export const CHRONICLE_CAP = 200;
export const pushEntry = (list: Entry[], e: Entry, cap = CHRONICLE_CAP): Entry[] => [...list, e].slice(-cap);

// Esc as omp's matchesKey("escape") takes it: a bare ESC or kitty CSI-u for 27 (optional shifted/base keys, either may be empty, and trailing text) whose modifier is 1 plus any Caps/Num Lock bits (64, 128), not a release (event 3).
// Not imported from pi-tui: extensions load with no runtime dependency on omp's packages.
const ESC_CSI_U = /^\x1b\[27(?::\d*)*(?:;(\d+)(?::(\d))?)?(?:;[\d:]*)?u$/;
export const closes = (data: string): boolean => {
	if (data === "\x1b" || data === "q") return true;
	const m = ESC_CSI_U.exec(data);
	return !!m && ((Number(m[1] ?? 1) - 1) & ~192) === 0 && m[2] !== "3";
};

const NAV_FINAL: Record<string, NavKey> = { A: "up", B: "down", C: "right", D: "left", H: "home" };
const NAV_VK: Record<number, NavKey> = { 36: "home", 37: "left", 38: "up", 39: "right", 40: "down", 9: "tab" };
const NAV_U: Record<number, NavKey> = { 9: "tab", 57417: "left", 57418: "right", 57419: "up", 57420: "down", 57423: "home" };
const NAV_PLAIN = /^\x1b[[O]([ABCDH])$/;
const NAV_MOD = /^\x1b\[1;(\d{1,3})(?::(\d))?([ABCDH])$/;
const NAV_CSI_U = /^\x1b\[(9|5741[789]|57420|57423)(?::\d*)*(?:;(\d{1,3})(?::(\d))?(?:;[\d:]*)?)?u$/;
const NAV_WIN32 = /^\x1b\[(\d{1,5});\d{0,5};\d{0,5};(\d);(\d{0,5});\d{0,5}_$/;
const plainMod = (m: string | undefined, ev: string | undefined) => ((Number(m ?? 1) - 1) & ~192) === 0 && (ev === undefined || ev === "1" || ev === "2");
/** The cursor key `data` is, or undefined. Arrows and Home in VT, SS3, xterm/kitty modified (locks allowed, no other modifier, press or repeat), Home as `CSI 1~`/`CSI 7~`, kitty keypad CSI-u, Tab, and win32-input-mode records (key down, no Alt/Ctrl/Shift). Any other sequence, a release, Alt+arrow and Shift+Tab give undefined, and never a bare Esc: closes() is false for all of them. Every pattern is anchored with bounded numbers, so a hostile string costs linear time. */
export const navKey = (data: string): NavKey | undefined => {
	if (data === "\t") return "tab";
	if (data === "\x1b[1~" || data === "\x1b[7~") return "home";
	const plain = NAV_PLAIN.exec(data);
	if (plain) return NAV_FINAL[plain[1]];
	const mod = NAV_MOD.exec(data);
	if (mod) return plainMod(mod[1], mod[2]) ? NAV_FINAL[mod[3]] : undefined;
	const u = NAV_CSI_U.exec(data);
	if (u) return plainMod(u[2], u[3]) ? NAV_U[Number(u[1])] : undefined;
	const w = NAV_WIN32.exec(data);
	return w && w[2] === "1" && (Number(w[3] || 0) & 0x1f) === 0 ? NAV_VK[Number(w[1])] : undefined;
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Agents that are no longer running, from what the host sends to the model: a task job's label is its agent id (eval agents are task jobs too), and an eval cell's agent status events carry the id and its last state. */
export function jobEnds(messages: unknown): { id: string; status: string }[] {
	const out: { id: string; status: string }[] = [];
	for (const m of Array.isArray(messages) ? messages : []) {
		const { jobs, cells } = obj(obj(m).details);
		for (const job of Array.isArray(jobs) ? jobs.map(obj) : [])
			if (job.type === "task" && job.status !== "running" && typeof job.label === "string") out.push({ id: job.label, status: String(job.status) });
		for (const cell of Array.isArray(cells) ? cells.map(obj) : []) {
			const events = obj(cell).statusEvents;
			for (const e of Array.isArray(events) ? events.map(obj) : [])
				if (e.op === "agent" && typeof e.id === "string" && ["completed", "failed", "aborted"].includes(String(e.status))) out.push({ id: e.id, status: String(e.status) });
		}
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

/** The name of the station the run is at (see activePhase); undefined with no phases. */
export const activeStation = (phases: Phase[]): string | undefined => phases[activePhase(phases)]?.name;

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
const RANK: Record<Kind, number> = { active: 0, failed: 1, idle: 2, done: 3 };
const HIDE: Kind[] = ["done", "idle", "failed", "active"]; // the order a +N more line names what it hides

export function cockpitView(input: ViewInput) {
	const ic = icons(!!input.glyphs);
	const phases = input.phases ?? [];
	const active = activePhase(phases); // -1 with no phases
	const browse = input.nav?.shown;
	// Browsing holds only while the run stays at the station it was taken at.
	const shown = browse && browse.from === active && Number.isInteger(browse.phase) && browse.phase >= 0 && browse.phase < phases.length ? browse.phase : undefined;
	const at = shown ?? active;
	const phase = phases.at(at); // undefined with no phases

	const doing = phases.at(active)?.tasks.find(t => t.status === "in_progress");
	const waiting = waitingSeal(phases);
	const back = !!doing && phases.slice(active + 1).some(p => p.tasks.some(t => t.status === "completed"));
	const station: { kind: Kind; mark: string; name: string; note?: string } = !phase
		? { kind: "idle", mark: "○", name: "no station yet" }
		: shown !== undefined
			? (() => {
					const done = phase.tasks.length > 0 && phase.tasks.every(t => t.status === "completed");
					const run = phase.tasks.some(t => t.status === "in_progress");
					const kind: Kind = done ? "done" : run ? "active" : "idle";
					return { kind, mark: MARK[kind], name: `${phase.name} · viewing · active: ${phases[active].name}` };
				})()
			: { kind: doing ? "active" : "idle", mark: doing ? (back ? ic.back : "▶") : "○", name: phase.name, ...(waiting ? { note: label(ic.seal, `seal ${clean(waiting.id)} awaits you`) } : {}) };
	const lines = waiting && input.seal?.id === waiting.id ? input.seal.lines.map(l => clean(l).trimEnd()) : [];
	const prepared = lines.some(l => l.trim()) ? lines : undefined;
	const panel = waiting && { title: label(ic.sealWait, `SEAL ${clean(waiting.id).toUpperCase()} · awaits you`), lines: prepared ?? ["the details are in the Captain's message"], prepared: !!prepared };

	const ids = [...new Set([...(input.slices ?? []), ...(input.stopped ?? [])].map(s => s.id))];
	const building = new Set(Object.values(input.agents ?? {}).map(s => s.id));
	const returned = new Set((input.stopped ?? []).map(s => s.id));
	const squads = ids.map(id => {
		const note = input.notes[id] ?? {};
		const [kind, state]: [Kind, string] = building.has(id)
			? ["active", "forging"]
			: note.failed
				? ["failed", "failed"]
				: returned.has(id)
					? ["done", "returned"]
					: ["idle", "awaiting deployment"];
		return { id, key: `squad:${id}`, kind, mark: MARK[kind], text: label(note.veteran ? ic.veteran : ic.brother, `squad ${id} ${state}`) };
	});

	const tasks = (phase?.tasks ?? []).flatMap((t, i) => {
		const m = t.content.match(ROLE_TAG);
		return m ? [{ id: `task:${i}:${t.content}`, status: t.status, role: (m[1] ?? m[2]).toLowerCase(), text: m[3] }] : [];
	});
	const seen = phase ? [...(input.deployed ?? [])].filter(([, d]) => d.station === phase.name) : []; // no phases: no station, so no boxes
	const boxes = BOXES.flatMap(def => {
		const mine = tasks.filter(t => def.tags.includes(t.role));
		const agents = seen.filter(([, d]) => def.tags.includes(d.role));
		if (!mine.length && !agents.length) return [];
		const brothers = def.tags.includes("battle-brother");
		// In the brothers' box every line carries the icon of its own rank.
		const who = (role: string, text: string) => (brothers ? label(role === "veteran" ? ic.veteran : ic.brother, text) : text);
		const row = (id: string, d: Deployed) => liveRow(d, input.live?.get(id), input.now);
		const lines: Line[] = [
			...mine.map(t => {
				const kind = ROLE_LINE[t.status] ?? "failed";
				return { id: t.id, kind, mark: MARK[kind], text: who(t.role, t.text) };
			}),
			// A forging squad's row is the first active agent deployed for it.
			...(brothers
				? squads.map(({ id, key, ...line }) => {
						const hit = line.kind === "active" ? agents.find(([, d]) => d.squad === id && d.state === "active") : undefined;
						return hit ? { ...line, id: key, ...row(...hit) } : { ...line, id: key };
					})
				: []),
			...agents.filter(([, d]) => !d.squad).map(([id, d]) => ({ id: `agent:${id}`, kind: d.state, mark: MARK[d.state], text: who(d.role, id), ...row(id, d) })),
		].sort((a, b) => RANK[a.kind] - RANK[b.kind]);
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

	const ord = new Map<string, number>();
	const chronicle = input.chronicle
		.map(e => {
			const k = `${e.at}|${e.who}|${e.text}`;
			const n = ord.get(k) ?? 0;
			ord.set(k, n + 1);
			return { ...e, id: `log:${k}#${n}` };
		})
		.reverse();
	const sealIds = panel && waiting ? panel.lines.map((_, i) => `seal:${waiting.id}:${i}`) : [];
	const items = [...sealIds.map(id => ({ id, group: "seal" })), ...boxes.flatMap(b => b.lines.map(l => ({ id: l.id, group: b.title }))), ...chronicle.map(e => ({ id: e.id, group: "chronicle" }))];
	const was = input.nav?.cursor;
	const found = was ? items.findIndex(i => i.id === was.id) : -1;
	const to = was && items.length ? (found >= 0 ? found : Math.min(Math.max(0, Math.trunc(was.at) || 0), items.length - 1)) : -1;
	const tops = Object.fromEntries(Object.entries(input.nav?.tops ?? {}).filter(([k, n]) => (k === "seal" ? !!panel : boxes.some(b => b.title === k)) && Number.isInteger(n) && n > 0));
	const nav: Nav = { ...(to >= 0 ? { cursor: { id: items[to].id, at: to } } : {}), ...(shown === undefined ? {} : { shown: { phase: shown, from: active } }), ...(Object.keys(tops).length ? { tops } : {}) };

	return { key: input.key, status: input.status, ic, clock, seals: sealsFrom(phases).map(s => ({ ...s, id: clean(s.id) })), station, panel, sealIds, boxes, chronicle, items, stations: { shown: at, active, count: phases.length }, nav };
}

/** A cursor move or a station browse, as `navigate` takes them. */
export type NavKey = "up" | "down" | "left" | "right" | "home" | "tab";

/** The next Nav after `key`, from the view's own (normalized) nav. Pure: ↑/↓ one item, clamped; Tab the first item of the next group, wrapping; ←/→ the shown station ∓1, clamped, landing on the active one clears `shown`; Home clears `shown`. The first ↑, ↓ or Tab selects the first item. */
export function navigate(view: View, key: NavKey): Nav {
	const { items, stations, nav } = view;
	const from = nav.cursor?.at ?? -1;
	const keep = nav.tops ? { tops: nav.tops } : {};
	const go = (i: number): Nav => ({ ...nav, ...(items.length ? { cursor: { id: items[i].id, at: i } } : {}) });
	switch (key) {
		case "up":
		case "down":
			return from < 0 ? go(0) : go(Math.min(items.length - 1, Math.max(0, from + (key === "up" ? -1 : 1))));
		case "tab": {
			if (!items.length) return nav;
			const next = from < 0 ? -1 : items.findIndex((it, i) => i > from && it.group !== items[from].group);
			return go(Math.max(0, next));
		}
		case "home":
			return { ...(nav.cursor ? { cursor: nav.cursor } : {}), ...keep };
		default: {
			if (!stations.count) return nav;
			const to = Math.min(stations.count - 1, Math.max(0, stations.shown + (key === "left" ? -1 : 1)));
			return { ...(nav.cursor ? { cursor: nav.cursor } : {}), ...keep, ...(to === stations.active ? {} : { shown: { phase: to, from: stations.active } }) };
		}
	}
}

const paint = (c: string, s: string) => c + s + RESET;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - Bun.stringWidth(s)));

const GRAPHEMES = new Intl.Segmenter();

/** Cut to `width` cells, keeping ANSI sequences whole and ending in `…` when something was dropped. */
function fit(line: string, width: number): string {
	if (Bun.stringWidth(line) <= width) return line;
	let out = "";
	let w = 0;
	// Per grapheme: a VS16 emoji or a ZWJ sequence is one glyph, wider than the sum of its code points.
	for (const [tok] of line.matchAll(/\x1b\[[0-9;]*m|[^\x1b]+|\x1b/gu)) {
		const parts = tok.startsWith("\x1b") ? [tok] : [...GRAPHEMES.segment(tok)].map(g => g.segment);
		for (const part of parts) {
			const tw = part.startsWith("\x1b") ? 0 : Bun.stringWidth(part);
			if (w + tw > width - 1) return `${out}…${RESET}`;
			out += part;
			w += tw;
		}
	}
	return `${out}…${RESET}`;
}

const kindTone: Record<Kind, Tone> = { active: "green", done: "green", failed: "red", idle: "iron" };
// Marks and text of a box: green/red/iron marks, parchment text unless the state itself speaks.
const mark = (k: Kind, m: string, frame: number) => (k === "active" && m === "▶" && frame % 2 ? "▷" : m);
const markText = (k: Kind, m: string, text: string, pal: Palette, frame = 0, tone?: Tone) =>
	`${paint(pal[tone ?? kindTone[k]], mark(k, m, frame))} ${paint(pal[tone ?? (k === "active" || k === "done" ? "parchment" : kindTone[k])], text)}`;

/** The run's seals in todo order as a chain; no seals, no row (the callers skip it). */
function sealsText(seals: Seal[], pal: Palette, ic: View["ic"]): string {
	return seals
		.map(s => {
			const sym = s.state === "pending" ? paint(pal.iron, "○") : paint(pal.gold, s.state === "granted" ? ic.sealOn : ic.sealWait);
			return `${sym} ${paint(pal.parchment, s.id)}`;
		})
		.join(paint(pal.iron, " → "));
}

const SEAL_CAP = 12;
/** The seal panel as a box: its lines parchment when prepared, else the default line in iron; past SEAL_CAP a window of SEAL_CAP - 1 lines that keeps the selected one (see windowOf) and an iron "+k more". `ids` name its lines for the cursor. */
function sealBox(panel: NonNullable<View["panel"]>, ids: string[], pal: Palette, win: Win, selected?: string): Box {
	const si = ids.indexOf(selected ?? "");
	const [start, end] = panel.lines.length > SEAL_CAP ? windowOf(panel.lines.map(() => 1), SEAL_CAP, si, win.get("seal")) : [0, panel.lines.length];
	win.set("seal", start);
	const lines = panel.lines.slice(start, end).map(l => paint(panel.prepared ? pal.parchment : pal.iron, l));
	if (end - start < panel.lines.length) lines.push(paint(pal.iron, `+${panel.lines.length - (end - start)} more`));
	return { title: panel.title, lines, tone: "gold", ...(si >= start && si < end ? { sel: si - start } : {}) };
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

// The agent's state under the clock: green and animated while a turn runs, gold (the most visible tone) when the user's turn comes. No line without a status.
const statusText = (status: View["status"], pal: Palette, frame: number): string[] =>
	status === "working" ? [markText("active", "▶", "AGENT AT WORK", pal, frame)] : status === "awaiting" ? [paint(pal.gold, "○ VOX OPEN · esc to give orders")] : [];

const entryLine = (e: Entry, pal: Palette) => {
	const tone: Tone = e.tone === "ok" ? "green" : e.tone === "fail" ? "red" : e.tone === "seal" || e.tone === "warn" ? "gold" : "parchment";
	return `${paint(pal.iron, e.at)}  ${paint(pal.parchment, pad(clean(e.who), 11))} ${paint(pal[tone], clean(e.text))}`;
};

type Box = { title: string; lines: string[]; tone: Tone; sel?: number }; // sel: the row of the selected line

/** The selected line's text in inverse video; SGR 7/27 is zero width, so no column moves. */
const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;
/** A selected line as one even inverse block: fitted to `width` cells as plain text first (fit's reset would otherwise end the inverse early, and its colours would break the block). */
const selected = (s: string, width: number) => inverse(fit(Bun.stripANSI(s), width));

function drawBox(b: Box, w: number, pal: Palette): string[] {
	const [tl, h, tr, v, bl, br] = "┌─┐│└┘";
	const c = (s: string) => paint(pal[b.tone], s);
	const title = fit(b.title, w - 5).replace(`…${RESET}`, "");
	return [
		c(`${tl}${h} ${title} ${h.repeat(w - Bun.stringWidth(title) - 5)}${tr}`),
		...b.lines.map((l, r) => `${c(v)}${r === b.sel ? paint(pal.gold, "▸") : " "}${pad(r === b.sel ? selected(l, w - 4) : fit(l, w - 4), w - 4)} ${c(v)}`),
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

// With a height: exactly that many lines, the chronicle on the spare rows, `blank` after it, `close` last; a too tall body is cut from the bottom. The chronicle window starts at 0 and follows the entry `sel` when it is past the spare rows.
function withHeight(body: string[], entries: string[], blank: string, close: string, height?: number, sel = -1): string[] {
	if (height === undefined) return [...body, ...entries, close];
	const spare = Math.max(0, height - body.length - 1);
	const from = sel >= spare ? sel - spare + 1 : 0;
	const shown = entries.slice(from, from + spare);
	return [...body, ...shown, ...Array(spare - shown.length).fill(blank)].slice(0, Math.max(0, height - 1)).concat(close);
}

// shortcut: a box keeps at least 1 line, so a window too short for every box at 1 line still cuts the chronicle; upgrade with the navigable cockpit (#13).
/** Lines a box may show: BOX_CAP, fewer when `height` must keep CHRONICLE_MIN chronicle rows after `fixed` rows and `blocks` rows of boxes that each add `chrome` rows; never under 1. */
const boxCap = (height: number | undefined, fixed: number, blocks: number, chrome: number) =>
	height === undefined || !blocks ? BOX_CAP : Math.max(1, Math.min(BOX_CAP, Math.floor((height - fixed - CHRONICLE_MIN) / blocks) - chrome));

/** The lines [start, end) a box past its cap shows in cap - 1 rows (`rows`: the rows of each line): from `top` (the window's last start), moved only as far as the selected line `sel` (-1: none) needs, pulled back up while room is left below, and always including the selected line even when it alone is taller than the room. */
function windowOf(rows: number[], cap: number, sel: number, top = 0): [number, number] {
	const room = cap - 1;
	const sum = (a: number, b: number) => rows.slice(a, b).reduce((x, y) => x + y, 0);
	let start = Math.min(Math.max(0, top), Math.max(0, rows.length - 1));
	if (sel >= 0 && sel < start) start = sel;
	while (start < sel && sum(start, sel + 1) > room) start++;
	while (start > 0 && sum(start - 1, rows.length) <= room) start--;
	let end = start;
	for (let used = 0; end < rows.length && used + rows[end] <= room; used += rows[end++]);
	return [start, Math.max(end, sel + 1)];
}

/** Where renderCockpit reads and writes the window starts, by box. */
type Win = { get: (k: string) => number; set: (k: string, n: number) => void };

/** A box's rows, at most cap (a detail is a row of its own, 2 cells in; gold when stalled, else iron): past it the window of whole lines (see windowOf) and an iron "+k more (…)" row counting every hidden line, above and below, by state in HIDE order. A line and its detail are never split. `sel` is the row of the selected line, if drawn. */
function boxLines(lines: View["boxes"][number]["lines"], cap: number, pal: Palette, frame: number, win: Win, key: string, selected?: string): { lines: string[]; sel?: number } {
	const rows = (l: Line) => (l.detail ? 2 : 1);
	const draw = (l: Line) => [markText(l.kind, l.mark, l.text, pal, frame, l.stalled && "gold"), ...(l.detail ? [`  ${paint(pal[l.stalled ? "gold" : "iron"], l.detail)}`] : [])];
	const si = lines.findIndex(l => l.id === selected);
	const [start, end] = lines.reduce((n, l) => n + rows(l), 0) <= cap ? [0, lines.length] : windowOf(lines.map(rows), cap, si, win.get(key));
	win.set(key, start);
	const out: string[] = [];
	let sel: number | undefined;
	for (const [i, l] of lines.slice(start, end).entries()) {
		if (start + i === si) sel = out.length;
		out.push(...draw(l));
	}
	const hidden = [...lines.slice(0, start), ...lines.slice(end)];
	if (hidden.length) {
		const parts = HIDE.map(k => [k, hidden.filter(l => l.kind === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
		out.push(paint(pal.iron, `+${hidden.length} more (${parts.join(", ")})`));
	}
	return { lines: out, ...(sel === undefined ? {} : { sel }) };
}

export function renderCockpit(view: View, width: number, frame: number, pal: Palette, height?: number): string[] {
	const lines = cockpitLines(view, width, frame, pal, height);
	// A themed background fills every line to the full width, so the overlay reads as one panel.
	return pal.bg ? lines.map(l => pal.bg + pad(l, width) + BG_RESET) : lines;
}

function cockpitLines(view: View, width: number, frame: number, pal: Palette, height?: number): string[] {
	const s = view.station;
	const station = markText(s.kind, s.mark, s.name, pal, frame) + (s.note ? ` · ${paint(pal.gold, s.note)}` : "");
	const sel = view.nav.cursor?.id;
	const win: Win = {
		get: k => view.nav.tops?.[k] ?? 0,
		set: (k, n) => {
			if (n > 0) (view.nav.tops ??= {})[k] = n;
			else if (view.nav.tops) {
				delete view.nav.tops[k];
				if (!Object.keys(view.nav.tops).length) delete view.nav.tops;
			}
		},
	};
	const boxes = (cap: number): Box[] => view.boxes.map(b => ({ title: b.title, tone: b.tone, ...boxLines(b.lines, cap, pal, frame, win, b.title, sel) }));
	const box = view.panel && sealBox(view.panel, view.sealIds, pal, win, sel);

	if (width < 72) {
		const ind = (b: Box) => b.lines.map((l, i) => (i === b.sel ? `${paint(pal.gold, "▸")} ${selected(l, width - 2)}` : `  ${l}`));
		const si = view.chronicle.findIndex(e => e.id === sel);
		const body = [
			`${paint(pal.gold, "✠ STRATEGIUM")} · ${paint(pal.parchment, view.key)}`,
			clockText(view.clock, pal, false),
			...statusText(view.status, pal, frame),
			...(view.seals.length ? [`${paint(pal.gold, "SEALS")} ${sealsText(view.seals, pal, view.ic)}`] : []),
			station,
			...(box ? [paint(pal.gold, box.title), ...ind(box)] : []),
			...boxes(boxCap(height, 5 + (view.seals.length ? 1 : 0) + (box ? box.lines.length + 1 : 0) + statusText(view.status, pal, frame).length, view.boxes.length, 1)).flatMap(b => [paint(pal.gold, b.title), ...ind(b)]),
			paint(pal.gold, "CHRONICLE"),
		];
		const entries = view.chronicle.map((e, i) => (i === si ? `${paint(pal.gold, "▸")} ${selected(entryLine(e, pal), width - 2)}` : entryLine(e, pal)));
		return withHeight(body, entries, "", paint(pal.iron, "esc/q close"), height, si).map(l => fit(l, width));
	}

	const inner = width - 2;
	const g = (t: string) => paint(pal.gold, t);
	const row = (content: string) => `${g("║")}${pad(fit(content, inner), inner)}${g("║")}`;
	const left = " " + clockText(view.clock, pal, true);
	const right = `${g("SEALS")} ${sealsText(view.seals, pal, view.ic)} `;
	const clockRow = !view.seals.length ? [row(left)] : Bun.stringWidth(left) + Bun.stringWidth(right) < inner ? [row(left + " ".repeat(inner - Bun.stringWidth(left) - Bun.stringWidth(right)) + right)] : [row(left), row(` ${right}`)];
	const head = [...clockRow, ...statusText(view.status, pal, frame).map(l => row(` ${l}`))];

	const lead = "╔═ ✠ STRATEGIUM ── COGITATOR ";
	const key = fit(view.key, Math.max(1, width - Bun.stringWidth(lead) - 5));
	const top = `${lead}${"═".repeat(Math.max(0, width - Bun.stringWidth(lead) - Bun.stringWidth(key) - 4))} ${key} ═╗`;
	const title = fit(station, inner - 4); // keeps at least one cell of rule
	const cols = Math.max(1, Math.min(view.boxes.length, Math.floor((inner - 1) / 27)));

	const si = view.chronicle.findIndex(e => e.id === sel);
	const hint = "esc/q close · ↑↓ line · ←→ station · tab box · home active";
	return withHeight(
		[g(fit(top, width)), ...head, `${g("╟─ ")}${title}${g(` ${"─".repeat(inner - 3 - Bun.stringWidth(title))}╢`)}`, ...(box ? grid([box], 1, inner, pal).map(row) : []), ...grid(boxes(boxCap(height, head.length + 4 + (box ? box.lines.length + 2 : 0), Math.ceil(view.boxes.length / cols), 2)), cols, inner, pal).map(row), g(`╟─ CHRONICLE ${"─".repeat(inner - 12)}╢`)],
		view.chronicle.map((e, i) => row(i === si ? `${g("▸")}${selected(entryLine(e, pal), inner - 1)}` : ` ${entryLine(e, pal)}`)),
		row(""),
		g(`╚═ ${hint} ${"═".repeat(inner - 3 - Bun.stringWidth(hint))}╝`),
		height,
		si,
	);
}
