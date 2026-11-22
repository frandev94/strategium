// Pure agent-name allocation (#133): lore names with a title, unique within a run, no I/O.
// Pools follow issue #62 (Warhammer 40,000 lore names, one CamelCase word each).

export type NameEntry = { name: string; agent: string; surname: string; squad?: string; spawned?: true; old?: true };
export type NameRequest = { agent: string; squad?: string; again?: boolean };

/** omp suffixes a repeated id up to `-999`, so 28 + 4 stays within omp's 32. */
export const MAX_NAME = 28;

const BROTHERS = [
	"Lorenzo", "Gideon", "Leon", "Deino", "Goriel", "Claudio", "Valencio", "Noctis", "Zael", "Scipio", "Omnio",
	"Uriel", "Pasanius", "Learchus", "Titus", "Leandros", "Sidonus", "Agemman", "Sicarius", "Chronus",
	"Tarkus", "Avitus", "Thule", "Gabriel", "Diomedes", "Martellus",
	"Dante", "Tycho", "Lemartes", "Rafen", "Arkio",
	"Ragnar", "Logan", "Bjorn", "Ulrik", "Lukas", "Arjac",
	"Azrael", "Belial", "Sammael",
	"Lysander", "Kantor", "Shrike", "Helbrecht", "Grimaldus", "Draigo", "Crowe", "Artemis", "Vulkan",
];

/** Pool per agent; `title` is fixed for roles, builders derive theirs. */
const ROLES: Record<string, { title: string; pool: readonly string[] }> = {
	librarian: { title: "Librarian", pool: ["Tigurius", "Mephiston", "Ezekiel", "Njal", "Jonah", "Isador", "Pyriel", "Calistarius", "Stern"] },
	archmagos: { title: "Archmagos", pool: ["Cawl", "Telok", "Kane"] },
	scout: {
		title: "Scout",
		pool: ["Telion", "Cyrus", "Naaman", "Oberdeii", "Gezrael", "Torvaec", "Skystalker", "Blackfang", "Vael", "Corvan", "Istvar", "Kesrin"],
	},
	inquisitor: { title: "Inquisitor", pool: ["Eisenhorn", "Ravenor", "Coteaz", "Karamazov", "Kryptman", "Greyfax", "Rex", "Czevak", "Draco", "Quixos"] },
	confessor: { title: "Confessor", pool: ["Jacobus", "Thor", "Cassius", "Asmodai", "Grimaldus"] },
	apothecary: {
		title: "Apothecary",
		pool: [
			"Corbulo", "Razaek", "Fabius", "Koh", "VonKalda", "Comendius",
			"Selenus", "Varnus", "Mordaius", "Hespero", "Galenor", "Castiel", "Ignatus", "Severan", "Orelio",
		],
	},
	"security-reviewer": { title: "Interrogator", pool: ["Thonius", "Fischig", "Aemos", "Bequin", "Nayl", "Kys", "Swole", "Frauka", "Lowink", "Medea"] },
	task: { title: "Adept", pool: ["Ortan", "Hesk", "Varro", "Tobin", "Brann", "Keld", "Jory", "Maro"] },
};

const EPITHETS = ["Unbroken", "Steadfast", "Elder", "Ashen", "Grim", "Bloodied", "Ironhand", "Revered"];

const BUILDERS = ["battle-brother", "veteran"];

export const NAMED_AGENTS: readonly string[] = [...BUILDERS, ...Object.keys(ROLES), "sonic"];

export const baseId = (id: string): string => id.replace(/-\d+$/, "");

const NO_FREE = (agent: string) => `no free name left for ${agent}: /strategium-config names off`;

const draw = (n: number, rand: () => number) => Math.min(n - 1, Math.floor(rand() * n));

/** First of `base` or `base`+epithet that is free and short enough. */
function freeName(base: string, taken: ReadonlySet<string>): string | undefined {
	for (const suffix of ["", ...EPITHETS]) {
		const name = base + suffix;
		if (name.length <= MAX_NAME && !taken.has(name)) return name;
	}
}

function servitor(taken: ReadonlySet<string>, rand: () => number): NameEntry | { error: string } {
	// shortcut: 200 draws, then an error; upgrade if a run ever needs that many servitors.
	for (let i = 0; i < 200; i++) {
		const letters = String.fromCharCode(65 + draw(26, rand), 65 + draw(26, rand));
		const surname = `${letters}${1 + draw(99, rand)}`;
		const name = `Servitor${surname}`;
		if (!taken.has(name)) return { name, agent: "sonic", surname };
	}
	return { error: NO_FREE("sonic") };
}

/** Pure: the entry to use, `fresh` when it must be appended; never mutates `entries`. Squad existence is the caller's check. */
export function allocateName(
	entries: readonly NameEntry[],
	req: NameRequest,
	avoid: ReadonlySet<string> = new Set(),
	rand: () => number = Math.random,
	opts: { prefer?: readonly string[]; skip?: ReadonlySet<string> } = {},
): { entry: NameEntry; fresh: boolean } | { error: string } {
	const { agent, squad, again } = req;
	if (!NAMED_AGENTS.includes(agent)) return { error: `unknown agent ${agent}: names are for ${NAMED_AGENTS.join(", ")}` };
	const builder = BUILDERS.includes(agent);
	if (builder && !squad) return { error: `${agent} needs a squad: strategium action name with agent and squad` };
	if (!builder && squad) return { error: `${agent} is not named per squad: drop squad` };
	if (builder && again) return { error: `again is not for ${agent}: a builder's next name follows its squad` };

	const taken = new Set([...entries.map((e) => e.name), ...avoid]);
	const fresh = (entry: NameEntry) => ({ entry, fresh: true as const });

	if (again) {
		const last = entries.findLast((e) => e.agent === agent);
		if (!last) return { error: `again for ${agent}: no earlier name to repeat` };
		if (!last.spawned) return { entry: last, fresh: false };
		if (agent === "sonic") {
			const s = servitor(taken, rand);
			return "error" in s ? s : fresh(s);
		}
		const name = freeName(ROLES[agent].title + last.surname, taken);
		return name ? fresh({ name, agent, surname: last.surname }) : { error: NO_FREE(agent) };
	}

	if (agent === "sonic") {
		const s = servitor(taken, rand);
		return "error" in s ? s : fresh(s);
	}

	let title: string;
	let surname: string | undefined;
	if (builder) {
		const live = entries.filter((e) => e.squad === squad && !e.old);
		const latest = live.at(-1);
		if (latest && latest.agent === agent && !latest.spawned) return { entry: latest, fresh: false };
		surname = latest?.surname;
		title = agent === "veteran" ? "Veteran" : live.some((e) => e.agent === "battle-brother" && e.spawned) ? "Penitent" : "Brother";
	} else {
		title = ROLES[agent].title;
	}
	const pool = builder ? BROTHERS : ROLES[agent].pool;
	const make = (s: string, name: string): { entry: NameEntry; fresh: true } =>
		fresh(builder ? { name, agent, surname: s, squad } : { name, agent, surname: s });

	if (surname) {
		const name = freeName(title + surname, taken);
		return name ? make(surname, name) : { error: NO_FREE(agent) };
	}
	const holders = (s: string) => entries.filter((e) => e.surname === s);
	// Both passes honour `prefer`. Pass 1: a surname nobody holds; pass 2 (pool exhausted): a surname only retired
	// builders or this role hold. Either way the surname is kept and the name made unique with an epithet, so a brother
	// whose bare name was issued earlier in this omp process (`avoid`) still comes back.
	const passes: ((s: string) => boolean)[] = [
		(s) => holders(s).length === 0,
		(s) => holders(s).every((e) => e.old || (!builder && e.agent === agent)),
	];
	// `prefer` surnames lead the candidates, so the first free one wins; otherwise draw from the pool.
	const prefer = opts.prefer ?? [];
	const candidates = [...new Set([...prefer, ...pool])].filter((s) => !opts.skip?.has(s));
	for (const eligible of passes) {
		const options: [string, string][] = [];
		for (const s of candidates) {
			const base = title + s;
			// Only a preferred surname is kept with an epithet; the rest need their bare name free.
			const name = !eligible(s) ? undefined : prefer.includes(s) || eligible === passes[1] ? freeName(base, taken) : base.length <= MAX_NAME && !taken.has(base) ? base : undefined;
			if (name) options.push([s, name]);
		}
		if (options.length && prefer.includes(options[0][0])) return make(...options[0]);
		if (options.length) {
			const [s, name] = options[draw(options.length, rand)];
			return make(s, name);
		}
	}
	return { error: NO_FREE(agent) };
}
