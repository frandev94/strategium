# Builds docs/banner-dark.svg and docs/banner-light.svg: Cinzel (OFL) text converted to paths, no font needed at view time.
# Usage: pip install fonttools; download Cinzel[wght].ttf from https://github.com/google/fonts/tree/main/ofl/cinzel
#        python tools/banner/banner.py path/to/Cinzel[wght].ttf docs
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

font_path, out = sys.argv[1], sys.argv[2]
bold = instantiateVariableFont(TTFont(font_path), {"wght": 800})
reg = instantiateVariableFont(TTFont(font_path), {"wght": 500})


def text_path(f, text, size, cx, baseline, tracking=0.0):
    gs, cmap, hmtx = f.getGlyphSet(), f.getBestCmap(), f["hmtx"]
    scale = size / f["head"].unitsPerEm
    names = [cmap[ord(c)] for c in text]
    width = sum(hmtx[n][0] for n in names) * scale + tracking * (len(names) - 1)
    x = cx - width / 2
    pen = SVGPathPen(gs, ntos=lambda v: ("%.1f" % v).rstrip("0").rstrip("."))
    for n in names:
        gs[n].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
        x += hmtx[n][0] * scale + tracking
    return pen.getCommands(), width


SKULL = "M12,2A9,9 0 0,0 3,11C3,14.03 4.53,16.82 7,18.47V22H9V19H11V22H13V19H15V22H17V18.46C19.47,16.81 21,14 21,11A9,9 0 0,0 12,2M8,11A2,2 0 0,1 10,13A2,2 0 0,1 8,15A2,2 0 0,1 6,13A2,2 0 0,1 8,11M16,11A2,2 0 0,1 18,13A2,2 0 0,1 16,15A2,2 0 0,1 14,13A2,2 0 0,1 16,11M12,14L13.5,17H10.5L12,14Z"

W, H = 1000, 240
title, tw = text_path(bold, "STRATEGIUM", 74, W / 2, 124, tracking=10)
sub, _ = text_path(reg, "AN ORCHESTRATOR WORKFLOW FOR OMP", 19, W / 2, 175, tracking=5)
motto, _ = text_path(reg, "THE CAPTAIN PLANS · THE SQUADS BUILD · YOU KEEP THE SEALS", 13, W / 2, 199, tracking=3)

THEMES = {
    "dark": dict(bg="#1e1b16", panel="#2a2620", gold="#e0b84a", rule="#b8963e", text="#e0b84a", sub="#f3e9cf", red="#7a1212", scan="#e0b84a", beam=".10"),
    "light": dict(bg="#f3e9cf", panel="#ead9b0", gold="#8a6a1f", rule="#8a6a1f", text="#5a0d0d", sub="#3a2f1e", red="#7a1212", scan="#7a1212", beam=".05"),
}


def svg(t):
    half = tw / 2
    lx, rx = W / 2 - half - 70, W / 2 + half + 22
    # Rules either side of the subtitle, ending in a lozenge.
    rules = "".join(
        f'<path d="M{a},144H{b}" stroke="{t["rule"]}" stroke-width="1.5"/>'
        f'<path d="M{d},139l5,5l-5,5l-5,-5z" fill="{t["gold"]}"/>'
        for a, b, d in ((90, 300, 300), (700, 910, 700))
    )
    rivets = "".join(
        f'<circle cx="{x}" cy="{y}" r="4" fill="{t["gold"]}"/>'
        for x in (22, W - 22) for y in (22, H - 22)
    )
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t">
<title id="t">Strategium: an orchestrator workflow for omp</title>
<style>
.scan{{animation:sweep 6s linear infinite}}
@keyframes sweep{{from{{transform:translateX(-160px)}}to{{transform:translateX({W + 160}px)}}}}
@media (prefers-reduced-motion:reduce){{.scan{{animation:none;opacity:0}}}}
</style>
<defs>
<linearGradient id="beam" x1="0" x2="1"><stop offset="0" stop-color="{t["scan"]}" stop-opacity="0"/><stop offset=".5" stop-color="{t["scan"]}" stop-opacity="{t["beam"]}"/><stop offset="1" stop-color="{t["scan"]}" stop-opacity="0"/></linearGradient>
<clipPath id="frame"><rect x="8" y="8" width="{W - 16}" height="{H - 16}" rx="6"/></clipPath>
</defs>
<rect x="8" y="8" width="{W - 16}" height="{H - 16}" rx="6" fill="{t["bg"]}" stroke="{t["rule"]}" stroke-width="2"/>
<rect x="34" y="34" width="{W - 68}" height="{H - 68}" fill="{t["panel"]}" stroke="{t["rule"]}" stroke-width="1" stroke-dasharray="2 4"/>
<g clip-path="url(#frame)"><rect class="scan" x="0" y="8" width="160" height="{H - 16}" fill="url(#beam)"/></g>
{rivets}
<path d="M8,{H / 2}h18M{W - 26},{H / 2}h18" stroke="{t["red"]}" stroke-width="4"/>
<g fill="{t["gold"]}">
<path transform="translate({lx},72) scale(2)" d="{SKULL}"/>
<path transform="translate({rx},72) scale(2)" d="{SKULL}"/>
</g>
<path fill="{t["text"]}" d="{title}"/>
{rules}
<path fill="{t["sub"]}" d="{sub}"/>
<path fill="{t["rule"]}" d="{motto}"/>
</svg>
'''


for name, t in THEMES.items():
    with open(f"{out}/banner-{name}.svg", "w", encoding="utf-8") as fh:
        fh.write(svg(t))
