// Windows ConPTY over bun:ffi (kernel32) for tools/tui-shot/shot.ts. Dev-only, Windows 10 1809+ only.
// kernel32 is opened lazily on the first start(), so shot.ts (and its tests) import on any OS.
import { dlopen, FFIType, ptr } from "bun:ffi";

const { u32, u64, i32 } = FFIType;
const P = FFIType.ptr;
// Handles and HPCON are u64 (bigint); BOOL returns are i32 (0 = failure); CreatePseudoConsole returns an HRESULT (0 = OK).
const load = () =>
	dlopen("kernel32.dll", {
		CreatePipe: { args: [P, P, P, u32], returns: i32 },
		CreatePseudoConsole: { args: [u32, u64, u64, u32, P], returns: i32 },
		ResizePseudoConsole: { args: [u64, u32], returns: i32 },
		ClosePseudoConsole: { args: [u64], returns: FFIType.void },
		InitializeProcThreadAttributeList: { args: [P, u32, u32, P], returns: i32 },
		UpdateProcThreadAttribute: { args: [P, u32, u64, u64, u64, P, P], returns: i32 },
		CreateProcessW: { args: [P, P, P, P, i32, u32, P, P, P, P], returns: i32 },
		PeekNamedPipe: { args: [u64, P, u32, P, P, P], returns: i32 },
		ReadFile: { args: [u64, P, u32, P, P], returns: i32 },
		WriteFile: { args: [u64, P, u32, P, P], returns: i32 },
		TerminateProcess: { args: [u64, u32], returns: i32 },
		CloseHandle: { args: [u64], returns: i32 },
		GetLastError: { args: [], returns: u32 },
	}).symbols;
let k: ReturnType<typeof load> | undefined;

/** COORD passed by value: one u32, X in the low word, Y in the high word. */
const coord = (x: number, y: number) => (((y & 0xffff) << 16) | (x & 0xffff)) >>> 0;
/** taskkill /F /T: omp's children survive TerminateProcess. */
export function killTree(pid: number) {
	Bun.spawnSync(["taskkill", "/F", "/T", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
}

/** One process in its own pseudo console. Output is polled (PeekNamedPipe every 20 ms, no thread) and handed to `sink` in order. */
export class Pty {
	pid = 0;
	private hpc = 0n;
	private inW = 0n;
	private outR = 0n;
	private hProcess = 0n;
	private hThread = 0n;
	private timer?: ReturnType<typeof setTimeout>;
	private stopped = false;
	private readonly buf = Buffer.alloc(65536);
	private readonly n = Buffer.alloc(4);
	private readonly avail = Buffer.alloc(4);

	constructor(
		private cols: number,
		private rows: number,
		private readonly sink: (b: Buffer) => void,
	) {}

	start(cmdline: string, cwd: string, env: Record<string, string>) {
		k ??= load();
		const h = Buffer.alloc(32); // inR, inW, outR, outW
		if (!k.CreatePipe(ptr(h, 0), ptr(h, 8), null, 0)) throw new Error(`CreatePipe in: ${k.GetLastError()}`);
		if (!k.CreatePipe(ptr(h, 16), ptr(h, 24), null, 0)) throw new Error(`CreatePipe out: ${k.GetLastError()}`);
		const inR = h.readBigUInt64LE(0), outW = h.readBigUInt64LE(24);
		this.inW = h.readBigUInt64LE(8);
		this.outR = h.readBigUInt64LE(16);
		const hpc = Buffer.alloc(8);
		const hr = k.CreatePseudoConsole(coord(this.cols, this.rows), inR, outW, 0, ptr(hpc));
		if (hr !== 0) throw new Error(`CreatePseudoConsole: hr 0x${(hr >>> 0).toString(16)}`);
		this.hpc = hpc.readBigUInt64LE(0);
		k.CloseHandle(inR); // the pseudo console holds its own copies of these two ends
		k.CloseHandle(outW);

		const sz = Buffer.alloc(8);
		k.InitializeProcThreadAttributeList(null, 1, 0, ptr(sz)); // fails by design: fills in the size
		const attr = Buffer.alloc(Number(sz.readBigUInt64LE(0)));
		if (!k.InitializeProcThreadAttributeList(ptr(attr), 1, 0, ptr(sz))) throw new Error(`InitializeProcThreadAttributeList: ${k.GetLastError()}`);
		// PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: lpValue is the HPCON value itself, cbSize = sizeof(HPCON)
		if (!k.UpdateProcThreadAttribute(ptr(attr), 0, 0x20016n, this.hpc, 8n, null, null)) throw new Error(`UpdateProcThreadAttribute: ${k.GetLastError()}`);
		const si = Buffer.alloc(112); // STARTUPINFOEXW (x64): cb@0, dwFlags@60, lpAttributeList@104
		si.writeUInt32LE(112, 0);
		si.writeUInt32LE(0x100, 60); // STARTF_USESTDHANDLES, null std handles
		si.writeBigUInt64LE(BigInt(ptr(attr)), 104);
		const pi = Buffer.alloc(24); // PROCESS_INFORMATION (x64): hProcess@0, hThread@8, pid@16
		// NUL-terminated UTF-16; the command line must be writable (CreateProcessW may write into it), and a Buffer is
		const cmd = Buffer.from(cmdline + "\0", "utf16le"), dir = Buffer.from(cwd + "\0", "utf16le");
		const envBlock = Buffer.from(Object.entries(env).map(([a, b]) => `${a}=${b}`).join("\0") + "\0\0", "utf16le");
		// EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT; attr, si, cmd, dir and envBlock stay referenced until it returns
		if (!k.CreateProcessW(null, ptr(cmd), null, null, 0, 0x80000 | 0x400, ptr(envBlock), ptr(dir), ptr(si), ptr(pi)))
			throw new Error(`CreateProcessW: ${k.GetLastError()}`);
		this.hProcess = pi.readBigUInt64LE(0);
		this.hThread = pi.readBigUInt64LE(8);
		this.pid = pi.readUInt32LE(16);
		this.poll();
	}
	/** Reads every byte available now into the sink; false once the pipe is closed or broken. */
	drain(): boolean {
		if (!k || this.stopped) return false;
		for (;;) {
			if (!k.PeekNamedPipe(this.outR, null, 0, null, ptr(this.avail), null)) return false;
			if (this.avail.readUInt32LE(0) === 0) return true;
			if (!k.ReadFile(this.outR, ptr(this.buf), this.buf.length, ptr(this.n), null)) return false;
			this.sink(Buffer.from(this.buf.subarray(0, this.n.readUInt32LE(0))));
		}
	}

	private poll = () => {
		if (this.drain()) this.timer = setTimeout(this.poll, 20);
	};

	send(s: string) {
		if (!k || this.stopped) return;
		const d = Buffer.from(s);
		k.WriteFile(this.inW, ptr(d), d.length, ptr(this.n), null);
	}

	resize(cols: number, rows: number) {
		this.cols = cols;
		this.rows = rows;
		if (k && !this.stopped) k.ResizePseudoConsole(this.hpc, coord(cols, rows));
	}

	/** Kills the process tree and frees everything. Idempotent. */
	stop() {
		if (!k || this.stopped || !this.hProcess) return;
		k.TerminateProcess(this.hProcess, 0);
		killTree(this.pid);
		this.drain();
		this.stopped = true;
		clearTimeout(this.timer);
		// outR drained and closed before ClosePseudoConsole: before Windows 11 24H2 it hangs waiting on an undrained output pipe.
		k.CloseHandle(this.outR);
		k.ClosePseudoConsole(this.hpc);
		for (const h of [this.hProcess, this.hThread, this.inW]) k.CloseHandle(h);
	}
}
