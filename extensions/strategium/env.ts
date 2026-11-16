/**
 * The environment a child process gets: only what it needs to run, never the whole omp environment
 * (which carries API keys). `extra` adds the variables the child needs for its job.
 */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	for (const k of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]) {
		const v = process.env[k];
		if (v) env[k] = v;
	}
	return { ...env, ...extra };
}
