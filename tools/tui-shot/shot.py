"""Run the real omp + this plugin in a Windows ConPTY, seed a run, and screenshot what the user sees, or replay past regressions. Windows only.

  python tools/tui-shot/shot.py [--seed=scriptorium|skirmish|timed] [--ponytail[=DIR]] [--suffix=-x] [--plugin=DIR]
                                [--out=DIR] [--omp=EXE] [--edge=EXE] [--no-png]
  python tools/tui-shot/shot.py --replay=NAME | --all  [--plugin=DIR] [--suffix=-x] [--out=DIR] [--omp=EXE] [--edge=EXE] [--no-png] [--keep-work]

Default mode writes screen<sfx>.* (the footer the seeded run draws, before Alt+C) and overlay<sfx>.* (after Alt+C).
--ponytail[=DIR]: also load the ponytail omp plugin (second -e), default dir found under ~/.omp/plugins; suffix defaults to -ponytail.
--replay=NAME runs one regression scenario (REPLAYS below): keys, resizes and waits in the real omp, text checks on the screen xterm.js holds at each
checkpoint; prints PASS/FAIL and exits 0/1 (unknown name: 2). --all runs every scenario and prints a table. --keep-work keeps the work dir (replay.log).
Outputs (default %TEMP%\\strategium-tui-shot): <name>.raw (VT bytes), <name>.html (xterm.js 5.5 from a CDN), <name>.png (headless Edge).
The run is seeded on disk and omp resumes a hand-written session with the same id, so no model call is spent (the replays that need a model use the fake provider in replay-ext.ts).
"""
import argparse, base64, datetime, glob, hashlib, html, json, os, re, shutil, subprocess, sys, tempfile, threading, time
import ctypes, ctypes.wintypes as w

COLS, ROWS = 140, 45
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
SID, KEY = "01a1eb00-0000-7000-8000-00000000d3a0", "demo-shot"  # the session id + run key tie claim, run file and session file together

# --- seeds: data only. Task text is "[role] Title"; status completed|in_progress|pending. To add one, add an entry here. ---
def t(c, s): return {"content": c, "status": s}
def sl(i): return {"id": i, "parallel": True, "files": []}
MUSTER = {"name": "Muster", "tasks": [t("[captain] Begin run", "completed"), t("[seal] Seals", "completed")]}
AUSPEX = {"name": "Auspex", "tasks": [t("[scout] Map the cockpit code", "completed")]}
INQ = {"name": "Inquisition", "tasks": [t("[inquisitor] Review the branch", "pending"), t("[seal] UI", "pending")]}
SCRIPTORIUM = {"name": "Scriptorium", "tasks": [t("[librarian] Plan area cockpit", "completed"), t("[librarian] Plan area docs", "completed"),
                                                t("[archmagos] Merge the plan", "completed"), t("[seal] Plan", "in_progress")]}
SEEDS = {
    "scriptorium": {  # planning station, a seal waiting for the Chapter Master
        "where": {"station": "Scriptorium", "seal": "Plan"}, "extra": {},
        "phases": [MUSTER, AUSPEX, SCRIPTORIUM,
            {"name": "Deployment", "tasks": [t("[captain] Declare the squads", "pending")]},
            {"name": "Skirmish", "tasks": [t("[battle-brother] Build the squads", "pending")]}, INQ]},
    "skirmish": {  # building station: two live agents, one stopped slice
        "where": {"station": "Skirmish", "task": "Build squad alpha"},
        "extra": {"agents": {"AlphaBrother": sl("alpha"), "GammaVeteran": sl("gamma")}, "stopped": [sl("beta")]},
        "phases": [MUSTER, AUSPEX,
            {"name": "Scriptorium", "tasks": [t("[librarian] Plan area cockpit", "completed"), t("[archmagos] Merge the plan", "completed"), t("[seal] Plan", "completed")]},
            {"name": "Deployment", "tasks": [t("[captain] Declare the squads", "completed")]},
            {"name": "Skirmish", "tasks": [t("[battle-brother] Build squad alpha", "in_progress"), t("[battle-brother] Build squad beta", "completed"),
                                           t("[veteran] Rebuild squad gamma", "in_progress"), t("[apothecary] Test squad beta", "in_progress"), t("[seal] Commit", "pending")]}, INQ]},
    "timed": {  # scriptorium, but a booked run (not untimed): today's day file has the start event with booked=240, as startKey writes it
        "where": {"station": "Scriptorium", "seal": "Plan"}, "extra": {}, "timed": 240,
        "phases": [MUSTER, AUSPEX, SCRIPTORIUM]},
}

ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
ap.add_argument("--seed", default="scriptorium", choices=SEEDS)
ap.add_argument("--ponytail", nargs="?", const=True, default=None)
ap.add_argument("--suffix")
ap.add_argument("--plugin", default=ROOT)
ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "strategium-tui-shot"))
ap.add_argument("--omp")
ap.add_argument("--edge")
ap.add_argument("--no-png", action="store_true")
ap.add_argument("--replay", metavar="NAME")
ap.add_argument("--all", action="store_true")
ap.add_argument("--keep-work", action="store_true")
A = ap.parse_args()
SFX = A.suffix if A.suffix is not None else ("-ponytail" if A.ponytail else "")
OUT = os.path.abspath(A.out); os.makedirs(OUT, exist_ok=True)
PLUGIN = os.path.abspath(A.plugin)
EXT = os.path.join(ROOT, "tools", "tui-shot", "replay-ext.ts")  # dev-only fake provider, always the harness's own copy

def find(opt, name, cands):
    p = opt or next((c for c in cands if c and os.path.exists(c)), None) or shutil.which(name)
    if not p: sys.exit(f"{name} not found: pass --{name}=PATH")
    return p
omp = find(A.omp, "omp", [])
pf = [os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")]
# The replay checks read the screen through xterm.js in Edge, so --no-png only skips the PNGs there.
edge = find(A.edge, "edge", [os.path.join(p, r"Microsoft\Edge\Application\msedge.exe") for p in pf if p]) if (A.replay or A.all or not A.no_png) else None
def find_pony():
    p = next(iter(sorted(glob.glob(os.path.join(os.path.expanduser("~"), ".omp", "plugins", "cache", "plugins", "ponytail___*")))[::-1]), None)
    if not p: sys.exit("ponytail plugin not found under ~/.omp/plugins/cache/plugins: pass --ponytail=DIR")
    return p
pony = (A.ponytail if A.ponytail is not True else find_pony()) if A.ponytail else None

# --- ConPTY (ctypes) ---
k = ctypes.WinDLL("kernel32", use_last_error=True)
HPCON = ctypes.c_void_p
class COORD(ctypes.Structure): _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]
class STARTUPINFOW(ctypes.Structure): _fields_ = [("cb", w.DWORD), ("r", w.LPWSTR), ("d", w.LPWSTR), ("t", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD), ("xs", w.DWORD), ("ys", w.DWORD), ("xc", w.DWORD), ("yc", w.DWORD), ("fa", w.DWORD), ("fl", w.DWORD), ("sw", w.WORD), ("cb2", w.WORD), ("r2", ctypes.c_void_p), ("si", w.HANDLE), ("so", w.HANDLE), ("se", w.HANDLE)]
class SIEX(ctypes.Structure): _fields_ = [("si", STARTUPINFOW), ("attr", ctypes.c_void_p)]
class PI(ctypes.Structure): _fields_ = [("hp", w.HANDLE), ("ht", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]
k.CreatePipe.argtypes = [ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), ctypes.c_void_p, w.DWORD]
k.CreatePseudoConsole.argtypes = [COORD, w.HANDLE, w.HANDLE, w.DWORD, ctypes.POINTER(HPCON)]
k.ResizePseudoConsole.argtypes = [HPCON, COORD]
k.ClosePseudoConsole.argtypes = [HPCON]
k.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]

def kill_tree(pid): subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)

# Keys as Windows Terminal sends them in win32-input-mode: CSI Vk;Sc;Uc;Kd;Cs;Rc _ (Cs: 2 left Alt, 128 Caps Lock, 256 enhanced key).
def rec(vk, sc, uc, kd, cs): return f"\x1b[{vk};{sc};{uc};{kd};{cs};1_"
KEYS = {
    "altc": [rec(18, 56, 0, 1, 2), rec(67, 46, 99, 1, 2), rec(67, 46, 99, 0, 2), rec(18, 56, 0, 0, 0)],
    "caps-altc": [rec(18, 56, 0, 1, 130), rec(67, 46, 67, 1, 130), rec(67, 46, 67, 0, 130), rec(18, 56, 0, 0, 128)],
    "esc": [rec(27, 1, 27, 1, 0), rec(27, 1, 27, 0, 0)],
    "q": [rec(81, 16, 113, 1, 0), rec(81, 16, 113, 0, 0)],
    "plain-q": ["q"],
    "down": [rec(40, 80, 0, 1, 256), rec(40, 80, 0, 0, 256)],
    "right": [rec(39, 77, 0, 1, 256), rec(39, 77, 0, 0, 256)],
    "enter": ["\r"],
}

class Run:
    """One omp in its own ConPTY, with its own throwaway work dir (state, session, cwd, edge profile) under OUT."""
    def __init__(self, seed, sfx, ext=False, ponytail=None):
        self.sfx, self.ext, self.cols, self.rows = sfx, ext, COLS, ROWS
        # Fixed name (it shows in omp's footer, so shots stay comparable) and per suffix (parallel runs need different --suffix).
        self.work = os.path.join(OUT, "work" + sfx)
        shutil.rmtree(self.work, ignore_errors=True)
        self.state, self.sess, self.cwd = (os.path.join(self.work, d) for d in ("state", "sessions", "cwd"))
        for d in (os.path.join(self.state, "runs"), os.path.join(self.state, "claims"), self.sess, self.cwd): os.makedirs(d)
        # Seed before omp starts: a session file with a fixed id, plus the run file and claim the extension reads.
        self.sfile = os.path.join(self.sess, f"2026-11-17T00-00-00-000Z_{SID}.jsonl")
        with open(self.sfile, "w") as f: f.write(json.dumps({"type": "session", "version": 3, "id": SID, "timestamp": "2026-11-17T00:00:00.000Z", "cwd": self.cwd}) + "\n")
        S = SEEDS[seed]
        self.runfile = os.path.join(self.state, "runs", SID + ".json")
        with open(self.runfile, "w") as f:
            json.dump({"key": KEY, "theatre": "none", "sid": SID, **({} if S.get("timed") else {"untimed": True}), "where": S["where"], "phases": S["phases"],
                       "slices": [sl(i) for i in ("alpha", "beta", "gamma", "delta")], **S["extra"]}, f)
        if S.get("timed"):  # the day file startKey would have written: local date, local time with offset
            now = datetime.datetime.now().astimezone().replace(microsecond=0)
            ts = max(now - datetime.timedelta(minutes=10), now.replace(hour=0, minute=0, second=0))
            with open(os.path.join(self.state, now.strftime("%Y-%m-%d") + ".jsonl"), "w") as f:
                f.write(json.dumps({"ts": ts.isoformat(), "event": "start", "key": KEY, "booked": S["timed"]}) + "\n")
        # Same lock name as timer.ts lockPath().
        with open(os.path.join(self.state, "claims", f"{KEY}-{hashlib.sha1(KEY.encode()).hexdigest()[:8]}.lock"), "w") as f: f.write(SID)
        self.beat = os.path.join(self.state, "runs", SID + ".beat")  # the extension writes it on its first tick
        self.log = os.path.join(self.work, "replay.log")
        self.cmd = f'"{omp}" --no-extensions --session-dir "{self.sess}" --resume "{self.sfile}" -e "{PLUGIN}"' + (f' -e "{ponytail}"' if ponytail else "")
        env = os.environ.copy()
        env.update(STRATEGIUM_STATE_DIR=self.state, STRATEGIUM_GLYPHS="1", TERM_PROGRAM="Windows_Terminal", WT_SESSION="00000000-0000-0000-0000-000000000001")
        if ext:  # every model role pinned to the fake provider: side turns (title...) never reach a real model either
            with open(os.path.join(self.work, "replay.yml"), "w") as f:
                f.write("modelRoles:\n" + "".join(f"  {r}: replay/ask\n" for r in ("default", "slow", "plan", "advisor", "task", "vision", "commit", "smol")))
            self.cmd += f' -e "{EXT}" --model replay/ask --config "{self.work}\\replay.yml"'
            env["STRATEGIUM_REPLAY_DIR"] = self.work
        inR, inW, outR, outW = w.HANDLE(), w.HANDLE(), w.HANDLE(), w.HANDLE()
        k.CreatePipe(ctypes.byref(inR), ctypes.byref(inW), None, 0); k.CreatePipe(ctypes.byref(outR), ctypes.byref(outW), None, 0)
        self.hpc = HPCON(); assert k.CreatePseudoConsole(COORD(COLS, ROWS), inR, outW, 0, ctypes.byref(self.hpc)) == 0
        sz = ctypes.c_size_t(); k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(sz))
        self.buf = ctypes.create_string_buffer(sz.value)
        assert k.InitializeProcThreadAttributeList(ctypes.byref(self.buf), 1, 0, ctypes.byref(sz))
        assert k.UpdateProcThreadAttribute(ctypes.byref(self.buf), 0, 0x20016, self.hpc, ctypes.sizeof(HPCON), None, None)
        si = SIEX(); si.si.cb = ctypes.sizeof(SIEX); si.attr = ctypes.cast(self.buf, ctypes.c_void_p); si.si.fl = 0x100
        self.pi = PI(); self.inW = inW; self.outR = outR
        envblock = "\0".join(f"{a}={b}" for a, b in env.items()) + "\0\0"
        assert k.CreateProcessW(None, ctypes.create_unicode_buffer(self.cmd), None, None, False, 0x80000 | 0x400, ctypes.create_unicode_buffer(envblock), self.cwd, ctypes.byref(si), ctypes.byref(self.pi)), ctypes.get_last_error()
        self.out = bytearray()
        self.events = []  # in call order: ("s", name, offset, png) snapshots and ("r", offset, cols, rows) resizes, replayed by the page
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        b = ctypes.create_string_buffer(65536); n = w.DWORD()
        while k.ReadFile(self.outR, b, 65536, ctypes.byref(n), None) and n.value: self.out.extend(b.raw[:n.value])

    def stop(self):
        k.TerminateProcess(self.pi.hp, 0); kill_tree(self.pi.pid)
        k.ClosePseudoConsole(self.hpc)
        for h in (self.pi.hp, self.pi.ht, self.inW): k.CloseHandle(h)  # not outR: closing it under the reader thread's pending ReadFile deadlocks

    def cleanup(self):
        if not A.keep_work: shutil.rmtree(self.work, ignore_errors=True)

    # --- steps ---
    def send(self, s):
        d = s.encode(); n = w.DWORD(); k.WriteFile(self.inW, d, len(d), ctypes.byref(n), None)
    def key(self, name):
        for s in KEYS[name]: self.send(s); time.sleep(0.03)
    def type_text(self, s): self.send(s); time.sleep(0.5)
    def sleep(self, s): time.sleep(s)
    def resize(self, cols, rows):
        k.ResizePseudoConsole(self.hpc, COORD(cols, rows)); self.cols, self.rows = cols, rows
        self.events.append(("r", len(self.out), cols, rows)); time.sleep(0.5)
    def wait_quiet(self, quiet=1.0, timeout=3.0):
        end = time.time() + timeout; last, since = len(self.out), time.time()
        while time.time() - since < quiet and time.time() < end:
            time.sleep(0.1)
            if len(self.out) != last: last, since = len(self.out), time.time()
    def wait_for(self, text, timeout):
        """Wait until `text` (bytes, no spaces: ConPTY may paint a gap as a cursor move) is in the stream; False on timeout."""
        end = time.time() + timeout
        while text not in self.out and time.time() < end: time.sleep(0.1)
        return text in self.out
    def wait_beat(self):
        end = time.time() + 60
        while not os.path.exists(self.beat) and time.time() < end: time.sleep(0.1)
        assert os.path.exists(self.beat), "extension never ticked: no run heartbeat in %s; omp said: %r" % (self.state, bytes(self.out)[-400:])
    def settle(self):
        """Ready = the extension ticked (heartbeat file exists) and the screen has been quiet for 2 s."""
        self.wait_beat(); self.wait_quiet(2, 60)
    def open(self): self.key("altc"); self.wait_quiet(1.0, 3.0)
    def alt_open(self): return self.out.rfind(b"\x1b[?1049h") > self.out.rfind(b"\x1b[?1049l")
    def snap(self, name, png=False):
        time.sleep(0.3); self.events.append(("s", name, len(self.out), png))
    def log_events(self):
        if not os.path.exists(self.log): return []
        return [json.loads(l) for l in open(self.log, encoding="utf8") if l.strip()]

# --- rendering: xterm.js 5.5 in headless Edge. One page replays the stream with the logged resizes; it dumps every snapshot or is photographed. ---
PAGE = """<!doctype html><meta charset=utf8>
<link rel=stylesheet href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>body{margin:0;background:#000;overflow:hidden}.xterm-viewport{overflow:hidden!important}#term{display:inline-block;padding:8px;background:#000}</style>
<div id=term></div><pre id=dump></pre>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.8.0/lib/addon-unicode11.js"></script>
<script>
const t=new Terminal({cols:@COLS@,rows:@ROWS@,fontFamily:'CaskaydiaCove Nerd Font Mono',fontSize:14,allowProposedApi:true,scrollback:0});
t.loadAddon(new Unicode11Addon.Unicode11Addon());t.unicode.activeVersion='11';  // emoji are 2 cells wide, as in Windows Terminal
t.open(document.getElementById('term'));
const bytes=Uint8Array.from(atob("@B64@"),c=>c.charCodeAt(0)),EV=@EV@,snaps=[];
function dump(name){const b=t.buffer.active,cells=[],wide=[];
  for(let y=0;y<t.rows;y++){const L=b.getLine(y),row=[];
    for(let x=0;x<t.cols;x++){const c=L.getCell(x),wd=c.getWidth();if(wd==0)row.push('');else{row.push(c.getChars()||' ');if(wd==2)wide.push([y,x]);}}
    cells.push(row);}
  return {name,type:b.type,cols:t.cols,rows:t.rows,cells,wide};}
let pos=0,i=0;
function next(){
  if(i>=EV.length){const rest=bytes.subarray(pos);pos=bytes.length;return t.write(rest,()=>setTimeout(()=>{document.getElementById('dump').textContent=JSON.stringify(snaps);document.body.dataset.done=1;},300));}
  const e=EV[i++];t.write(bytes.subarray(pos,e[1]),()=>{pos=e[1];if(e[0]=='r')t.resize(e[2],e[3]);else snaps.push(dump(e[2]));next();});}
document.fonts.load('14px "CaskaydiaCove Nerd Font Mono"').finally(next);
</script>"""

def page(name, data, events, cols=COLS, rows=ROWS):
    """Write <name>.raw and <name>.html for the stream `data` (events: ("r", offset, cols, rows) / ("s", offset, name))."""
    open(os.path.join(OUT, name + ".raw"), "wb").write(data)
    ev = [[e[0], e[1], e[2], e[3]] if e[0] == "r" else ["s", e[1], e[2]] for e in events]
    open(os.path.join(OUT, name + ".html"), "w", encoding="utf8").write(
        PAGE.replace("@COLS@", str(cols)).replace("@ROWS@", str(rows)).replace("@B64@", base64.b64encode(data).decode()).replace("@EV@", json.dumps(ev)))

def edge_run(prof, args, capture=False):
    p = subprocess.Popen([edge, "--headless=new", "--disable-gpu", "--user-data-dir=" + prof, "--hide-scrollbars", "--window-size=1200,780", "--virtual-time-budget=20000", *args],
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try: return p.communicate(timeout=90)[0]
    except subprocess.TimeoutExpired: return b""
    finally: kill_tree(p.pid)

def shoot(prof, name):
    png = os.path.join(OUT, name + ".png")
    if os.path.exists(png): os.remove(png)
    edge_run(prof, ["--screenshot=" + png, "file:///" + os.path.join(OUT, name + ".html").replace("\\", "/")])
    if not os.path.exists(png): sys.exit(f"edge produced no {png} (the xterm.js CDN needs network)")

# --- default mode: the two shots ---
def capture():
    R = Run(A.seed, SFX, ponytail=pony)
    names = []
    try:
        R.settle()
        page("screen" + SFX, bytes(R.out), [])  # the footer the seeded run draws on its first tick
        R.key("altc")  # Alt+C as Windows Terminal sends it in win32-input-mode: Alt down, C down/up, Alt up
        time.sleep(1.5)
        page("overlay" + SFX, bytes(R.out), [])  # the screen + the Alt+C delta, replayed in one stream
        names = ["screen" + SFX, "overlay" + SFX]
    finally:
        R.stop()
    try:
        if edge and not A.no_png:  # headless Edge with a throwaway profile, never the user's
            for n in names: shoot(os.path.join(R.work, "edge-profile"), n)
    finally:
        R.cleanup()
    print("done", PLUGIN, "raw bytes", len(R.out), "->", ", ".join(os.path.join(OUT, n + (".html" if A.no_png else ".png")) for n in names))

# --- replays: snapshot reading and check helpers ---
class Snap:
    """The screen xterm.js held at a checkpoint: one string per cell (a wide cell's continuation cell is ""), the active buffer, the size."""
    def __init__(s, d):
        s.name, s.type, s.cols, s.rows, s.cells, s.wide = d["name"], d["type"], d["cols"], d["rows"], d["cells"], {tuple(x) for x in d["wide"]}
        s.rows_text = ["".join(r).rstrip() for r in s.cells]
    def row(s, y): return s.rows_text[y] if 0 <= y < s.rows else ""
    def at(s, y, x): return s.cells[y][x] if 0 <= y < s.rows and 0 <= x < len(s.cells[y]) else ""
    def has(s, text): return any(text in r for r in s.rows_text)
    def where(s, text):
        """First row index holding `text`, or -1."""
        return next((y for y, r in enumerate(s.rows_text) if text in r), -1)
    def col_of(s, y, text):
        """Cell index of the first cell of `text` in row y, or -1."""
        full = "".join(s.cells[y]); i = full.find(text)
        if i < 0: return -1
        n = 0
        for x, c in enumerate(s.cells[y]):
            if n >= i: return x
            n += len(c)
        return -1
    def last_col(s, y):
        """Cell index of the last non-blank cell of row y (-1: blank row)."""
        return next((x for x in range(len(s.cells[y]) - 1, -1, -1) if s.cells[y][x].strip()), -1)
    def wide_cells(s, y0=0, y1=None): return sorted((y, x) for y, x in s.wide if y >= y0 and (y1 is None or y < y1))
    def framed(s): return any(r.startswith("╔═") for r in s.rows_text)
    def dump(s): return [f"{y:2} |{r}" for y, r in enumerate(s.rows_text) if r]

def one_of(c, chars): return c != "" and c in chars

class Ctx:
    """What a scenario's checks see: its snapshots, its run, and ck() to record a check."""
    def __init__(s, R, snaps): s.R, s.s, s.results, s.notes = R, snaps, [], []
    def ck(s, name, ok, got=None, want=None, snap=None):
        s.results.append((name, bool(ok), got, want, snap))
    def say(s, line): s.notes.append(line)
    def log_has(s, ev, **kw): return any(e.get("ev") == ev and all(e.get(a) == b for a, b in kw.items()) for e in s.R.log_events())

# --- scenarios. Steps drive the run (R); checks read snapshots (C). To add one: a steps function, a checks function, an entry in REPLAYS. ---
def open_snap(R, png=True): R.open(); R.snap("open", png)

def steps_fullscreen_height(R): R.snap("before"); open_snap(R)
def checks_fullscreen_height(C):
    b, o = C.s["before"], C.s["open"]
    C.ck("before: no cockpit frame", not b.framed(), snap=b)
    C.ck("open: alternate buffer", o.type == "alternate", o.type, "alternate")
    C.ck("open: row 0 is the top frame", o.row(0).startswith("╔═") and "STRATEGIUM" in o.row(0), o.row(0)[:50], "╔═ … STRATEGIUM", o)
    C.ck(f"open: row {o.rows - 1} is the bottom frame", o.row(o.rows - 1).startswith("╚═ esc/q close"), o.row(o.rows - 1)[:50], "╚═ esc/q close", o)
    bad = [y for y in range(1, o.rows - 1) if not (one_of(o.at(y, 0), "║╟") and one_of(o.at(y, o.cols - 1), "║╢"))]
    C.ck(f"open: rows 1-{o.rows - 2} framed at col 0 and col {o.cols - 1}", not bad, f"rows {bad}", None, o)
    leak = [y for y in range(o.rows) if "strategium: demo-shot" in o.row(y) or "ALT + C" in o.row(y)]
    C.ck("open: no footer or editor under the cockpit", not leak, f"rows {leak}", None, o)

def steps_fullscreen_resize(R):
    R.open(); R.resize(140, 30); R.wait_quiet(1.0, 3.0); R.snap("h30")
    R.resize(100, 45); R.wait_quiet(1.0, 3.0); R.snap("w100"); R.resize(60, 45); R.wait_quiet(1.0, 3.0); R.snap("w60", True)
def checks_fullscreen_resize(C):
    a, b, c = C.s["h30"], C.s["w100"], C.s["w60"]
    C.ck("h30: 30 rows", a.rows == 30, a.rows, 30)
    C.ck("h30: row 0 top frame, row 29 bottom frame", a.row(0).startswith("╔═") and a.row(29).startswith("╚═ esc/q close"), (a.row(0)[:20], a.row(29)[:20]), None, a)
    bad = [y for y in range(1, 44) if not one_of(b.at(y, 99), "║╢")]
    C.ck("w100: col 99 framed on rows 1-43", b.cols == 100 and not bad, f"cols {b.cols} rows {bad}", None, b)
    C.ck("w60: stacked, no top frame", not c.framed() and "╔" not in "".join(c.rows_text), None, None, c)
    C.ck("w60: last row is esc/q close", "esc/q close" in c.row(c.rows - 1), c.row(c.rows - 1), "esc/q close", c)
    C.ck("w60: nothing past col 59", c.cols == 60 and all(c.last_col(y) < 60 for y in range(c.rows)), c.cols, 60, c)

def steps_frame_edges(R):
    R.open()
    for n, cw in (("w140", 140), ("w100", 100), ("w72", 72)):
        if cw != 140: R.resize(cw, 45); R.wait_quiet(1.0, 3.0)
        R.snap(n)
def checks_frame_edges(C):
    for n, s in C.s.items():
        W = s.cols
        bad = [y for y in range(s.rows) if one_of(s.at(y, 0), "╔║╟╚") and not one_of(s.at(y, W - 1), "╗║╢╝")]
        C.ck(f"{n}: every framed row ends at col {W - 1}", not bad, f"rows {bad}", None, s)
        y = s.where("CHRONICLE")
        C.ck(f"{n}: CHRONICLE rule ends ═…║ at col {W - 1}, no notch", y >= 0 and s.last_col(y) == W - 1 and one_of(s.at(y, W - 1), "║╢") and s.at(y, W - 2) in "─═", s.row(y)[-12:], "…─╢", s)
        # A grid row of boxes runs from the row with ┌ to the row with └; all its rows end at one edge, and so do the grid rows with the same number of boxes.
        edge = lambda y: max((x for x in range(W - 1) if one_of(s.at(y, x), "┐│┤┘")), default=-1)
        blocks, top = {}, None
        for y in range(s.rows):
            if "┌" in s.row(y): top = y
            if top is not None and edge(y) >= 0: blocks.setdefault(top, set()).add(edge(y))
            if "└" in s.row(y): top = None
        per_count = {}
        for y, e in blocks.items(): per_count.setdefault(s.row(y).count("┐"), set()).update(e)
        C.ck(f"{n}: box grid has one right edge per box count (no staircase)", bool(blocks) and all(len(e) == 1 for e in per_count.values()), per_count, None, s)

def steps_glyph_width(R): R.snap("screen"); open_snap(R, False)
def checks_glyph_width(C):
    for n in ("screen", "open"):
        s = C.s[n]
        C.ck(f"{n}: no ⚔ ☠ ⏳", not any(g in r for r in s.rows_text for g in "⚔☠⏳"), None, None, s)
    y = C.s["screen"].where("strategium: demo-shot")
    C.ck("screen: no wide cell in the footer run line", y >= 0 and not C.s["screen"].wide_cells(y, y + 1), C.s["screen"].wide_cells(y, y + 1), [], C.s["screen"])
    C.ck("open: no wide cell in the cockpit", not C.s["open"].wide_cells(), C.s["open"].wide_cells(), [], C.s["open"])

def steps_seal_row(R): open_snap(R)
def checks_seal_row(C):
    o = C.s["open"]; y = o.where("SEALS")
    xs = [x for x, c in enumerate(o.cells[y]) if c in ("\U000f047a", "\U000f051f")] if y >= 0 else []
    C.ck("SEALS row has seal glyphs U+F047A/U+F051F", bool(xs), o.row(y), None, o)
    C.ck("each seal glyph is 1 cell wide and followed by a space", all((y, x) not in o.wide and o.at(y, x + 1) == " " for x in xs), xs, None, o)
    C.ck("no ✠ in the SEALS row", "✠" not in o.row(y), o.row(y), None, o)

def steps_archmagos(R): open_snap(R, False)
def checks_archmagos(C): C.ck("Merge the plan ([archmagos]) is in the cockpit", C.s["open"].has("Merge the plan"), None, None, C.s["open"])

def steps_agent_status(R): open_snap(R)
def checks_agent_status(C):
    o = C.s["open"]; end = next((y for y in range(1, o.rows) if o.row(y).startswith("╟─")), o.rows)
    head = "\n".join(o.row(y) for y in range(1, end)); y = o.where("AWAITING YOUR ORDERS")
    C.ck("header has AWAITING YOUR ORDERS", "AWAITING YOUR ORDERS" in head, head, None, o)
    C.ck("header has no AGENT AT WORK / PLAN REVIEW PENDING", "AGENT AT WORK" not in head and "PLAN REVIEW PENDING" not in head, head, None, o)
    C.ck(f"status row ends with ║ at col {o.cols - 1}", y >= 0 and o.at(y, o.cols - 1) == "║", o.row(y), None, o)

def steps_first_tick_clock(R): R.sleep(1.5); open_snap(R, False)  # settled by the beat only: the 60 s tick is the first draw with a clock
def checks_first_tick_clock(C):
    o = C.s["open"]; y = o.where("⧗")
    C.ck("clock row shows /240 min", y >= 0 and "/240 min" in o.row(y), o.row(y), "⧗ N/240 min", o)
    C.ck("clock row is not ⧗ …", y >= 0 and "⧗ …" not in o.row(y), o.row(y), None, o)

def steps_resume_booking(R):
    R.settle(); R.type_text("/strategium-pause"); R.key("enter"); R.sleep(1.5)
    R.type_text("/strategium-resume 240"); R.key("enter"); R.sleep(1.5); R.snap("footer"); open_snap(R, False)
def checks_resume_booking(C):
    f, o = C.s["footer"], C.s["open"]; y = f.where("strategium: demo-shot"); c = o.where("⧗")
    C.ck("footer run line shows /240 min", y >= 0 and "/240 min" in f.row(y), f.row(y), None, f)
    C.ck("cockpit clock shows /240 min", c >= 0 and "/240 min" in o.row(c), o.row(c), None, o)
    C.ck("cockpit clock row has a bar", c >= 0 and any(g in o.row(c) for g in "▰▱"), o.row(c), "▰▱…", o)

def steps_no_widget(R): R.snap("screen")
def checks_no_widget(C):
    s = C.s["screen"]
    C.ck("no cockpit box or title above the editor", not any(g in r for r in s.rows_text for g in ("╔", "┌", "STRATEGIUM")), None, None, s)
    C.ck("footer run line is there", s.has("strategium: demo-shot"), None, None, s)

def steps_ask(R):
    R.type_text("replay-ask"); R.key("enter"); R.sleep(1.0); open_snap(R); R.snap("cockpit", True)
    open(os.path.join(R.work, "go"), "w").close()  # releases the fake stream: it now calls ask
    R.wait_for(b"REPLAY:", 10); R.wait_quiet(1.0, 3.0); R.snap("dialog", True)
    # The form's hint line (html-form/dialog.ts): "←/→ change · enter next · ↑↓ move": → picks No, enter moves to the submit stop, enter submits. (↓ moves between stops: it would skip to submit with Yes.)
    R.key("right"); R.sleep(0.5); R.key("enter"); R.sleep(0.5); R.key("enter"); R.sleep(0.5)
    R.wait_for(b"REPLAY-ANSWER", 10); R.wait_quiet(1.0, 3.0); R.snap("answered", True)
def checks_ask(C):
    c, d, a = C.s["cockpit"], C.s["dialog"], C.s["answered"]
    C.ck("cockpit: rows 0 and last are the frame", c.row(0).startswith("╔═") and c.row(c.rows - 1).startswith("╚═"), (c.row(0)[:20], c.row(c.rows - 1)[:20]), None, c)
    C.ck("dialog: cockpit closed, normal buffer", d.type == "normal" and not d.framed(), d.type, "normal, no frame", d)
    y = d.where("Ask"); [C.say("dialog | " + d.row(i)) for i in range(max(y, 0), min(y + 8, d.rows)) if d.row(i)]  # the dialog as drawn, with its hint line
    C.ck("dialog: REPLAY: pick one, Yes and No on screen", d.has("REPLAY: pick one") and d.has("Yes") and d.has("No"), None, None, d)
    y = a.where("REPLAY-ANSWER"); C.ck("answered: REPLAY-ANSWER with No", y >= 0 and '"pick": "No"' in " ".join(a.row(i) for i in range(y, y + 5)), None, None, a)  # the answer prints as a JSON block under it
    C.ck("answered: no cancel on screen", not any("cancel" in r.lower() for r in a.rows_text), None, None, a)
    C.ck("replay.log: tool_call ask", C.log_has("tool_call", name="ask"), [e for e in C.R.log_events() if e["ev"] in ("tool_call", "tool_result")])
    C.ck("replay.log: tool_result ask isError false with No", any(e.get("ev") == "tool_result" and e.get("name") == "ask" and e.get("isError") is False and "No" in e.get("text", "") for e in C.R.log_events()), [e for e in C.R.log_events() if e["ev"] == "tool_result"])

def steps_run_end(R):
    R.open(); os.remove(R.runfile); end = time.time() + 65
    while R.alt_open() and time.time() < end: time.sleep(0.5)
    R.wait_quiet(1.5, 5.0); R.snap("after")
def checks_run_end(C):
    s = C.s["after"]
    C.ck("after: no cockpit frame, normal buffer", s.type == "normal" and not s.framed(), s.type, "normal, no frame", s)
    C.ck("after: footer has no demo-shot run line", not s.has("strategium: demo-shot"), None, None, s)

HINT = "ALT + C to enter cockpit"
def steps_footer_hint(R):
    R.snap("w140"); R.resize(100, 45); R.wait_quiet(1.0, 3.0)
    # The footer reads the width once per draw (index.ts, "no resize hook in omp"): it redraws on the next 60 s tick or status refresh. /strategium-status refreshes it.
    R.type_text("/strategium-status"); R.key("enter"); R.sleep(1.5); R.snap("w100")
def checks_footer_hint(C):
    for n, s in C.s.items():
        y = s.where(HINT); x = s.col_of(y, HINT) + len(HINT) - 1 if y >= 0 else -1
        C.ck(f"{n}: last char of the hint at col {s.cols - 1}", x == s.cols - 1, f"col {x}, gap {s.cols - 1 - x}", s.cols - 1, s)
        if x != s.cols - 1: C.say(f"{n}: last 3 rows: " + " / ".join(repr(s.row(y)) for y in range(s.rows - 3, s.rows)))

ESC = {  # name -> what is sent: win32 is Windows Terminal's real path; the others go through conhost's own input parser
    "win32": KEYS["esc"], "plain": ["\x1b"], "csi-u": ["\x1b[27u"], "csi-u-mod": ["\x1b[27;1u"],
    "csi-u-events": ["\x1b[27;1:1u", "\x1b[27;1:3u"], "csi-u-caps": ["\x1b[27;65u"], "csi-u-num": ["\x1b[27;129u"]}
def steps_esc_close(R):
    R.notes = {}
    for v, seqs in ESC.items():
        R.open()
        if not R.alt_open(): R.notes[v] = None; continue
        inputs = lambda: [e["data"] for e in R.log_events() if e["ev"] == "input"]
        n = len(inputs())
        for s in seqs: R.send(s); R.sleep(0.03)
        R.sleep(1.5); R.snap(v)
        R.notes[v] = (not R.alt_open(), "".join(inputs()[n:]), seqs)
        if R.alt_open(): R.key("q"); R.wait_quiet(1.0, 3.0)
def checks_esc_close(C):
    for v in ESC:
        n = C.R.notes.get(v)
        if n is None: C.ck(f"{v}: cockpit was open before the key", False, "ERROR: the frame was not up, variant skipped"); continue
        if not n[1]:  # omp never received a byte: conhost holds a lone ESC, so the variant tests nothing about the cockpit (omp saw the same single \x1b for the win32 record)
            C.say(f"{v:13} skip: not delivered, omp's onTerminalInput saw nothing (conhost holds a lone ESC)"); continue
        s = C.s[v]
        C.ck(f"{v}: closes (normal buffer, no frame, footer back)", n[0] and s.type == "normal" and not s.framed() and s.has("strategium: demo-shot"), s.type, "normal, no frame", s)
        sent, saw = "".join(n[2]), n[1]
        C.say(f"{v:13} closed={'yes' if n[0] else 'NO '} sent={sent!r} onTerminalInput saw={saw!r}" + ("  not faithful: conhost rewrote it" if v != "win32" and sent != saw else ""))

def steps_q_close(R):
    R.snap("before"); R.open(); R.key("q"); R.wait_quiet(1.0, 3.0); R.snap("after", True)
    R.open(); R.key("plain-q"); R.wait_quiet(1.0, 3.0); R.snap("after2")
def checks_q_close(C):
    b = C.s["before"]; keep = lambda s: [r for r in s.rows_text if " min" not in r]  # the clock row changes
    for n in ("after", "after2"):
        s = C.s[n]
        C.ck(f"{n}: normal buffer, no frame", s.type == "normal" and not s.framed(), s.type, "normal, no frame", s)
        C.ck(f"{n}: footer and editor rows as before", keep(s) == keep(b), None, None, s)

def steps_capslock(R):
    R.key("caps-altc"); R.sleep(1.5); R.snap("after")
    R.type_text("/strategium-cockpit"); R.key("enter"); R.wait_quiet(1.0, 3.0); R.snap("alternative", True)
def checks_capslock(C):
    s = C.s["after"]
    C.ck("no cockpit", s.type == "normal" and not s.framed(), s.type, "normal, no frame", s)
    C.ck("Nothing to copy on screen or in the stream", s.has("Nothing to copy") or b"Nothing to copy" in C.R.out, None, None, s)
    C.ck("after: the footer hint names the cockpit key", s.has(HINT), None, HINT, s)
    a = C.s["alternative"]
    C.ck("alternative: /strategium-cockpit opens the cockpit", a.type == "alternate" and a.framed(), a.type, "alternate, framed", a)

def steps_select(R):
    R.type_text("/replay-select"); R.key("enter"); R.open(); R.sleep(4)
    R.key("down"); R.key("enter"); R.sleep(0.5); R.snap("held")
    R.key("q"); R.wait_quiet(1.0, 3.0); R.key("down"); R.key("enter"); R.sleep(1.0); R.snap("after-q")
def checks_select(C):
    sel = [e for e in C.R.log_events() if e.get("ev") == "select"]
    C.ck("held: no select value (keys went to the cockpit)", not sel, sel)
    s = C.s["after-q"]
    C.ck("after-q: still no value", not sel, sel)
    C.ck("after-q: the select is still drawn (the omp limit F9 cannot reach)", s.type == "normal" and s.has("REPLAY select"), s.type, None, s)

def steps_ponytail(R): R.snap("screen")
def checks_ponytail(C): C.ck("Strategium loaded: is in the stream", b"Strategium loaded:" in C.R.out, None, None, C.s["screen"])

# name -> r (the regression), kind FIXED|KNOWN|OPEN, seed, ext (fake provider), ponytail, settle (False: wait only for the first heartbeat), steps, checks
REPLAYS = {
    "fullscreen-height":  {"r": "R9", "kind": "FIXED", "seed": "scriptorium", "steps": steps_fullscreen_height, "checks": checks_fullscreen_height},
    "fullscreen-resize":  {"r": "R9/F6", "kind": "FIXED", "seed": "scriptorium", "steps": steps_fullscreen_resize, "checks": checks_fullscreen_resize},
    "frame-edges":        {"r": "R4,R5", "kind": "FIXED", "seed": "skirmish", "steps": steps_frame_edges, "checks": checks_frame_edges},
    "glyph-width":        {"r": "R2", "kind": "FIXED", "seed": "skirmish", "steps": steps_glyph_width, "checks": checks_glyph_width},
    "seal-row":           {"r": "R3", "kind": "FIXED", "seed": "scriptorium", "steps": steps_seal_row, "checks": checks_seal_row},
    "archmagos":          {"r": "R13", "kind": "FIXED", "seed": "scriptorium", "steps": steps_archmagos, "checks": checks_archmagos},
    "agent-status":       {"r": "F11", "kind": "FIXED", "seed": "scriptorium", "steps": steps_agent_status, "checks": checks_agent_status},
    "first-tick-clock":   {"r": "R6", "kind": "FIXED", "seed": "timed", "settle": False, "steps": steps_first_tick_clock, "checks": checks_first_tick_clock},
    "resume-booking":     {"r": "R7", "kind": "FIXED", "seed": "scriptorium", "steps": steps_resume_booking, "checks": checks_resume_booking},
    "no-widget":          {"r": "R8", "kind": "FIXED", "seed": "scriptorium", "steps": steps_no_widget, "checks": checks_no_widget},
    "ask-behind-cockpit": {"r": "R10", "kind": "FIXED", "seed": "scriptorium", "ext": True, "steps": steps_ask, "checks": checks_ask},
    "run-end-closes":     {"r": "R12", "kind": "FIXED", "seed": "scriptorium", "steps": steps_run_end, "checks": checks_run_end},
    "footer-hint":        {"r": "R14", "kind": "FIXED", "seed": "scriptorium", "steps": steps_footer_hint, "checks": checks_footer_hint},
    "esc-close":          {"r": "R19", "kind": "FIXED", "seed": "scriptorium", "ext": True, "steps": steps_esc_close, "checks": checks_esc_close},
    "q-close":            {"r": "R19", "kind": "FIXED", "seed": "scriptorium", "steps": steps_q_close, "checks": checks_q_close},
    "capslock-altc":      {"r": "R1", "kind": "KNOWN", "seed": "scriptorium", "steps": steps_capslock, "checks": checks_capslock},
    "select-behind-cockpit": {"r": "R10", "kind": "KNOWN", "seed": "scriptorium", "ext": True, "steps": steps_select, "checks": checks_select},
    "ponytail-notice":    {"r": "R16", "kind": "OPEN", "seed": "scriptorium", "ponytail": True, "settle": False, "steps": steps_ponytail, "checks": checks_ponytail},
}

def parse_snaps(dom):
    m = re.search(r'<pre id="dump"[^>]*>(.*?)</pre>', dom, re.S)
    return {d["name"]: Snap(d) for d in json.loads(html.unescape(m.group(1)))} if m and m.group(1).strip() else {}

def replay(name):
    """Run one scenario; returns (result, first failing check). Prints one line per check, then PASS/FAIL NAME (R)."""
    sc = REPLAYS[name]; sfx = SFX + "-" + name
    R = Run(sc["seed"], sfx, sc.get("ext", False), find_pony() if sc.get("ponytail") else None)
    print(f"== {name} ({sc['r']}, {sc['kind']})\n   omp: {R.cmd}")
    err = None; C = None
    try:
        try:
            R.settle() if sc.get("settle", True) else R.wait_beat()
            sc["steps"](R)
        except Exception as e: err = f"{type(e).__name__}: {e}"
        finally: R.stop()
        data, prof = bytes(R.out), os.path.join(R.work, "edge-profile")
        pev = lambda upto: [("r", *e[1:]) if e[0] == "r" else ("s", e[2], e[1]) for e in R.events if e[0] == "r" and e[1] <= upto or e[0] == "s" and e[2] <= upto]
        for e in R.events:  # <scenario>-<checkpoint>.raw/.html: the stream up to the checkpoint, resizes included
            if e[0] == "s": page(f"{name}-{e[1]}", data[:e[2]], [x for x in pev(e[2]) if x[0] == "r"])
        snaps = {}
        if any(e[0] == "s" for e in R.events) and err is None:
            page(f"{name}-all", data, pev(len(data)))
            dom = edge_run(prof, ["--dump-dom", "file:///" + os.path.join(OUT, f"{name}-all.html").replace("\\", "/")], True).decode("utf8", "replace")
            snaps = parse_snaps(dom); want = sum(1 for e in R.events if e[0] == "s")
            if len(snaps) != want: err = f"edge returned {len(snaps)} snapshots of {want} (the xterm.js CDN needs network)"
            for e in R.events:
                if e[0] == "s" and e[3] and not A.no_png and err is None: shoot(prof, f"{name}-{e[1]}")
        C = Ctx(R, snaps)
        if err is None:
            try: sc["checks"](C)
            except Exception as e: err = f"checks raised {type(e).__name__}: {e}"
    finally:
        R.cleanup()
    first = None
    for n, ok, got, want, snap in (C.results if C else []):
        print(f"   {'ok  ' if ok else 'FAIL'} {n}" + ("" if ok else f": got {got!r}" + (f", expected {want!r}" if want is not None else "")))
        if not ok:
            first = first or n
            if snap is not None:
                print(f"        screen '{snap.name}' ({snap.cols}x{snap.rows}, {snap.type}):"); [print("        " + l) for l in snap.dump()]
    if err: print(f"   ERROR {err}"); first = first or err
    for l in (C.notes if C else []): print("   " + l)
    res = "PASS" if first is None else "FAIL"
    print(f"{res} {name} ({sc['r']})")
    return res, first

def sha_of(plugin):
    for p in (plugin + ".sha", os.path.join(plugin, ".sha")):
        if os.path.exists(p): return open(p).read().strip()
    return "unknown (no .sha next to the plugin)"

def run_replays():
    if A.replay and A.replay not in REPLAYS:
        print(f"unknown replay {A.replay!r}; valid names:\n  " + "\n  ".join(REPLAYS)); return 2
    names = list(REPLAYS) if A.all else [A.replay]
    print(f"plugin {PLUGIN} sha {sha_of(PLUGIN)}")
    rows = [(n, REPLAYS[n]["r"], REPLAYS[n]["kind"], *replay(n)) for n in names]
    if not A.all: return 0 if rows[0][3] == "PASS" else 1
    print(f"\nplugin {PLUGIN} sha {sha_of(PLUGIN)}\n{'scenario':24} | {'R':6} | {'kind':5} | {'result':6} | first failing check")
    for n, r, kind, res, first in rows: print(f"{n:24} | {r:6} | {kind:5} | {res:6} | {first or ''}")
    return 1 if any(kind != "OPEN" and res != "PASS" for _, _, kind, res, _ in rows) else 0

if A.replay or A.all: sys.exit(run_replays())
capture()
