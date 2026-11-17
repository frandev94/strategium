"""Run the real omp + this plugin in a Windows ConPTY, seed a run, and screenshot what the user sees. Windows only.

  python tools/tui-shot/shot.py [--seed=scriptorium|skirmish] [--ponytail[=DIR]] [--suffix=-x] [--plugin=DIR]
                                [--out=DIR] [--omp=EXE] [--edge=EXE] [--no-png]

Writes screen<sfx>.* (the footer the seeded run draws, before Alt+C) and overlay<sfx>.* (after Alt+C).
--ponytail[=DIR]: also load the ponytail omp plugin (second -e), default dir found under ~/.omp/plugins; suffix defaults to -ponytail.
Outputs (default %TEMP%\\strategium-tui-shot): <name>.raw (VT bytes), <name>.html (xterm.js 5.5 from a CDN), <name>.png (headless Edge).
The run is seeded on disk and omp resumes a hand-written session with the same id, so no model call is spent.
"""
import argparse, atexit, base64, glob, hashlib, json, os, shutil, subprocess, sys, tempfile, threading, time
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
SEEDS = {
    "scriptorium": {  # planning station, a seal waiting for the Chapter Master
        "where": {"station": "Scriptorium", "seal": "Plan"}, "extra": {},
        "phases": [MUSTER, AUSPEX,
            {"name": "Scriptorium", "tasks": [t("[librarian] Plan area cockpit", "completed"), t("[librarian] Plan area docs", "completed"),
                                              t("[archmagos] Merge the plan", "completed"), t("[seal] Plan", "in_progress")]},
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
A = ap.parse_args()
SFX = A.suffix if A.suffix is not None else ("-ponytail" if A.ponytail else "")
OUT = os.path.abspath(A.out); os.makedirs(OUT, exist_ok=True)
PLUGIN = os.path.abspath(A.plugin)

def find(opt, name, cands):
    p = opt or next((c for c in cands if c and os.path.exists(c)), None) or shutil.which(name)
    if not p: sys.exit(f"{name} not found: pass --{name}=PATH")
    return p
omp = find(A.omp, "omp", [])
pf = [os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")]
edge = None if A.no_png else find(A.edge, "edge", [os.path.join(p, r"Microsoft\Edge\Application\msedge.exe") for p in pf if p])
pony = None
if A.ponytail:
    pony = A.ponytail if A.ponytail is not True else next(iter(sorted(glob.glob(os.path.join(os.path.expanduser("~"), ".omp", "plugins", "cache", "plugins", "ponytail___*")))[::-1]), None)
    if not pony: sys.exit("ponytail plugin not found under ~/.omp/plugins/cache/plugins: pass --ponytail=DIR")

# Everything omp writes lives in a throwaway dir under OUT, removed at exit. Its name is fixed (it shows in omp's footer, so shots stay comparable) and per suffix (parallel runs need different --suffix).
WORK = os.path.join(OUT, "work" + SFX)
shutil.rmtree(WORK, ignore_errors=True)
atexit.register(shutil.rmtree, WORK, ignore_errors=True)
STATE, SESS, CWD = (os.path.join(WORK, d) for d in ("state", "sessions", "cwd"))
for d in (os.path.join(STATE, "runs"), os.path.join(STATE, "claims"), SESS, CWD): os.makedirs(d)

# Seed before omp starts: a session file with a fixed id, plus the run file and claim the extension reads.
SFILE = os.path.join(SESS, f"2026-11-17T00-00-00-000Z_{SID}.jsonl")
with open(SFILE, "w") as f: f.write(json.dumps({"type": "session", "version": 3, "id": SID, "timestamp": "2026-11-17T00:00:00.000Z", "cwd": CWD}) + "\n")
S = SEEDS[A.seed]
with open(os.path.join(STATE, "runs", SID + ".json"), "w") as f:
    json.dump({"key": KEY, "theatre": "none", "sid": SID, "untimed": True, "where": S["where"], "phases": S["phases"],
               "slices": [sl(i) for i in ("alpha", "beta", "gamma", "delta")], **S["extra"]}, f)
# Same lock name as timer.ts lockPath().
with open(os.path.join(STATE, "claims", f"{KEY}-{hashlib.sha1(KEY.encode()).hexdigest()[:8]}.lock"), "w") as f: f.write(SID)
BEAT = os.path.join(STATE, "runs", SID + ".beat")  # the extension writes it on its first tick

# --- ConPTY (ctypes) ---
k = ctypes.WinDLL("kernel32", use_last_error=True)
HPCON = ctypes.c_void_p
class COORD(ctypes.Structure): _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]
class STARTUPINFOW(ctypes.Structure): _fields_ = [("cb", w.DWORD), ("r", w.LPWSTR), ("d", w.LPWSTR), ("t", w.LPWSTR), ("x", w.DWORD), ("y", w.DWORD), ("xs", w.DWORD), ("ys", w.DWORD), ("xc", w.DWORD), ("yc", w.DWORD), ("fa", w.DWORD), ("fl", w.DWORD), ("sw", w.WORD), ("cb2", w.WORD), ("r2", ctypes.c_void_p), ("si", w.HANDLE), ("so", w.HANDLE), ("se", w.HANDLE)]
class SIEX(ctypes.Structure): _fields_ = [("si", STARTUPINFOW), ("attr", ctypes.c_void_p)]
class PI(ctypes.Structure): _fields_ = [("hp", w.HANDLE), ("ht", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]
k.CreatePipe.argtypes = [ctypes.POINTER(w.HANDLE), ctypes.POINTER(w.HANDLE), ctypes.c_void_p, w.DWORD]
k.CreatePseudoConsole.argtypes = [COORD, w.HANDLE, w.HANDLE, w.DWORD, ctypes.POINTER(HPCON)]
k.ClosePseudoConsole.argtypes = [HPCON]
k.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
inR, inW, outR, outW = w.HANDLE(), w.HANDLE(), w.HANDLE(), w.HANDLE()
k.CreatePipe(ctypes.byref(inR), ctypes.byref(inW), None, 0); k.CreatePipe(ctypes.byref(outR), ctypes.byref(outW), None, 0)
hpc = HPCON(); assert k.CreatePseudoConsole(COORD(COLS, ROWS), inR, outW, 0, ctypes.byref(hpc)) == 0
sz = ctypes.c_size_t(); k.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(sz))
buf = ctypes.create_string_buffer(sz.value)
assert k.InitializeProcThreadAttributeList(ctypes.byref(buf), 1, 0, ctypes.byref(sz))
assert k.UpdateProcThreadAttribute(ctypes.byref(buf), 0, 0x20016, hpc, ctypes.sizeof(HPCON), None, None)
si = SIEX(); si.si.cb = ctypes.sizeof(SIEX); si.attr = ctypes.cast(buf, ctypes.c_void_p); si.si.fl = 0x100
pi = PI()

cmd = f'"{omp}" --no-extensions --session-dir "{SESS}" --resume "{SFILE}" -e "{PLUGIN}"' + (f' -e "{pony}"' if pony else "")
env = os.environ.copy()
env.update(STRATEGIUM_STATE_DIR=STATE, STRATEGIUM_GLYPHS="1", TERM_PROGRAM="Windows_Terminal", WT_SESSION="00000000-0000-0000-0000-000000000001")
envblock = "\0".join(f"{a}={b}" for a, b in env.items()) + "\0\0"
assert k.CreateProcessW(None, ctypes.create_unicode_buffer(cmd), None, None, False, 0x80000 | 0x400, ctypes.create_unicode_buffer(envblock), CWD, ctypes.byref(si), ctypes.byref(pi)), ctypes.get_last_error()

out = bytearray()
def rd():
    b = ctypes.create_string_buffer(65536); n = w.DWORD()
    while k.ReadFile(outR, b, 65536, ctypes.byref(n), None) and n.value: out.extend(b.raw[:n.value])
threading.Thread(target=rd, daemon=True).start()
def send(s):
    d = s.encode(); n = w.DWORD(); k.WriteFile(inW, d, len(d), ctypes.byref(n), None)

def page(name, data):
    open(os.path.join(OUT, name + ".raw"), "wb").write(data)
    b64 = base64.b64encode(data).decode()
    open(os.path.join(OUT, name + ".html"), "w", encoding="utf8").write(f"""<!doctype html><meta charset=utf8>
<link rel=stylesheet href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<style>body{{margin:0;background:#000;overflow:hidden}}.xterm-viewport{{overflow:hidden!important}}#term{{display:inline-block;padding:8px;background:#000}}</style>
<div id=term></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-unicode11@0.8.0/lib/addon-unicode11.js"></script>
<script>
const t=new Terminal({{cols:{COLS},rows:{ROWS},fontFamily:'CaskaydiaCove Nerd Font Mono',fontSize:14,allowProposedApi:true,scrollback:0}});
t.loadAddon(new Unicode11Addon.Unicode11Addon());t.unicode.activeVersion='11';  // emoji are 2 cells wide, as in Windows Terminal
t.open(document.getElementById('term'));
const bytes=Uint8Array.from(atob("{b64}"),c=>c.charCodeAt(0));
document.fonts.load('14px "CaskaydiaCove Nerd Font Mono"').finally(()=>t.write(bytes,()=>setTimeout(()=>document.body.dataset.done=1,300)));
</script>""")

def settle():
    """Ready = the extension ticked (heartbeat file exists) and the screen has been quiet for 2 s."""
    end = time.time() + 60
    while not os.path.exists(BEAT) and time.time() < end: time.sleep(0.25)
    assert os.path.exists(BEAT), "extension never ticked: no run heartbeat in %s; omp said: %r" % (STATE, bytes(out)[-400:])
    last, quiet = len(out), time.time()
    while time.time() - quiet < 2 and time.time() < end:
        time.sleep(0.25)
        if len(out) != last: last, quiet = len(out), time.time()

def kill_tree(pid): subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)

names = []
try:
    settle()
    page("screen" + SFX, bytes(out))  # the footer the seeded run draws on its first tick
    # Alt+C as Windows Terminal sends it in win32-input-mode: Alt down, C down/up, Alt up.
    send("\x1b[18;56;0;1;2;1_"); send("\x1b[67;46;99;1;2;1_"); send("\x1b[67;46;99;0;2;1_"); send("\x1b[18;56;0;0;0;1_")
    time.sleep(1.5)
    page("overlay" + SFX, bytes(out))  # the screen + the Alt+C delta, replayed in one stream
    names = ["screen" + SFX, "overlay" + SFX]
finally:
    k.TerminateProcess(pi.hp, 0); kill_tree(pi.pid)
    k.ClosePseudoConsole(hpc)
    for h in (pi.hp, pi.ht, inW): k.CloseHandle(h)  # not outR: closing it under the reader thread's pending ReadFile deadlocks

if edge:  # headless Edge with a throwaway profile, never the user's
    for n in names:
        png = os.path.join(OUT, n + ".png")
        if os.path.exists(png): os.remove(png)
        p = subprocess.Popen([edge, "--headless=new", "--disable-gpu", "--user-data-dir=" + os.path.join(WORK, "edge-profile"), "--hide-scrollbars",
            "--window-size=1200,780", "--virtual-time-budget=20000", "--screenshot=" + png, "file:///" + os.path.join(OUT, n + ".html").replace("\\", "/")],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try: p.wait(90)
        except subprocess.TimeoutExpired: pass
        finally: kill_tree(p.pid)
        if not os.path.exists(png): sys.exit(f"edge produced no {png} (the xterm.js CDN needs network)")
print("done", PLUGIN, "raw bytes", len(out), "->", ", ".join(os.path.join(OUT, n + (".html" if A.no_png else ".png")) for n in names))
