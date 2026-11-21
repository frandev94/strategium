/**
 * The environment a child process gets: only what it needs to run, never the whole omp environment
 * (which carries API keys). `extra` adds the variables the child needs for its job.
 */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};
	// Non-secret names the alarm needs to find its audio player and notifier (Windows: SystemDrive for ProgramData; Linux: the session bus and display).
	for (const k of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "SystemDrive", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]) {
		const v = process.env[k];
		if (v) env[k] = v;
	}
	return { ...env, ...extra };
}
