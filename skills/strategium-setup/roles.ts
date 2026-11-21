export const ROLE_AGENTS = {
	plan: "librarian and archmagos",
	slow: "inquisitor",
	task: "apothecary, confessor without Codex, and standard-tier battle-brothers",
} as const;

const FALLBACK = {
	plan: "run on the session's model",
	slow: "run on the configured default, or on omp's slow list (the costliest model) when default is unset too",
	task: "run on the session's model",
} as const;

export function missingRoles(roles: unknown): string[] {
	const map: Record<string, unknown> =
		roles && typeof roles === "object" && !Array.isArray(roles) ? (roles as Record<string, unknown>) : {};
	return (Object.keys(ROLE_AGENTS) as (keyof typeof ROLE_AGENTS)[])
		.filter((role) => typeof map[role] !== "string" || !(map[role] as string).trim())
		.map(
			(role) =>
				`WARN modelRoles.${role} is unset: ${ROLE_AGENTS[role]} ${FALLBACK[role]}. Set it in modelRoles (README, "Models").`,
		);
}

if (import.meta.main) {
	try {
		const p = Bun.spawnSync(["omp", "config", "get", "modelRoles", "--json"]);
		if (p.exitCode !== 0) throw new Error(p.stderr.toString().trim() || `omp exited ${p.exitCode}`);
		const warnings = missingRoles(JSON.parse(p.stdout.toString()).value);
		console.log(warnings.length ? warnings.join("\n") : "OK modelRoles sets plan, slow and task");
	} catch (e) {
		console.log(`ERROR could not read modelRoles: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}
