// Builds docs/banner-dark.svg and docs/banner-light.svg: Cinzel (OFL) text converted to paths, no font needed at view time.
// Colours: docs/style.md (Blood Angels palette).
// Usage: bun tools/banner/banner.ts path/to/Cinzel[wght].ttf docs
// Font: https://raw.githubusercontent.com/google/fonts/main/ofl/cinzel/Cinzel%5Bwght%5D.ttf
//       file sha256 f4d83d34d1f6c741193e4acf4b3dff9531e5a67b6aa65228d00a7db72a4e0f34
// opentype.js only parses the tables; the variable-font instancing and the path emission replicate fontTools,
// so the output is byte-identical to the former banner.py (LF line endings).
// opentype.js is pinned exactly: its own instancer differs from fontTools, so a bump can change the output.
// normalizeWght assumes a single wght axis. The instancing mirrors fontTools 4.68.0.
// Oracle: regenerate into docs/ and `git diff --exit-code docs/banner-*.svg` must stay clean.
import * as ot from "opentype.js";
import { readFileSync, writeFileSync } from "node:fs";

type Pt = { x: number; y: number; onCurve: boolean; lastPointOfContour: boolean };
type P = [number, number];

// Python "%.1f" % v, then .rstrip("0").rstrip("."). toFixed picks the larger neighbour on an exact
// tie (odd/4 is the only exact tie at one decimal); Python picks the even one. Negative zero keeps its sign.
export function ntos(v: number): string {
  const a = Math.abs(v);
  let s: string;
  if (Number.isInteger(a * 4) && (a * 4) % 2 === 1) {
    let n = Math.floor(a * 10);
    if (n % 2) n++; // half-even
    s = (n / 10).toFixed(1);
  } else s = a.toFixed(1);
  if (v < 0 || Object.is(v, -0)) s = "-" + s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}
const pts = (p: P) => `${ntos(p[0])} ${ntos(p[1])}`;

// SVGPathPen + BasePen.qCurveTo, fed already-transformed points.
export class Pen {
  out: string[] = [];
  last = "";
  lx: number | null = null;
  ly: number | null = null;
  cur: P | null = null;
  moveTo(p: P) {
    if (this.last === "M") this.out.pop();
    this.out.push("M" + pts(p));
    this.last = "M";
    [this.lx, this.ly] = p;
  }
  lineTo(p: P) {
    const [x, y] = p;
    let t: string;
    if (x === this.lx && y === this.ly) return;
    else if (x === this.lx) { t = "V" + ntos(y); this.last = "V"; }
    else if (y === this.ly) { t = "H" + ntos(x); this.last = "H"; }
    else if (this.last === "M") t = " " + pts(p);
    else { t = "L" + pts(p); this.last = "L"; }
    this.out.push(t);
    [this.lx, this.ly] = p;
  }
  qCurveTo(...points: (P | null)[]) {
    const n = points.length - 1;
    if (points[points.length - 1] === null) {
      const [x, y] = points[points.length - 2]!;
      const [nx, ny] = points[0]!;
      const imp: P = [0.5 * (x + nx), 0.5 * (y + ny)];
      this.moveTo(imp);
      points = [...points.slice(0, -1), imp];
    }
    const ps = points as P[];
    if (n === 0) return this.lineTo(ps[0]);
    for (let i = 0; i < ps.length - 2; i++) {
      const [x, y] = ps[i];
      const [nx, ny] = ps[i + 1];
      this.q(ps[i], [0.5 * (x + nx), 0.5 * (y + ny)]);
    }
    this.q(ps[ps.length - 2], ps[ps.length - 1]);
  }
  q(p1: P, p2: P) {
    this.out.push("Q" + pts(p1) + " " + pts(p2));
    this.last = "Q";
    [this.lx, this.ly] = p2;
  }
  closePath() {
    this.out.push("Z");
    this.last = "Z";
    this.lx = this.ly = null;
  }
}

// fontTools glyf Glyph.draw for quadratic outlines (no cubic flags in TrueType-flavoured Cinzel).
function drawGlyph(points: Pt[], pen: Pen, tr: (p: P) => P) {
  let start = 0;
  for (let i = 0; i < points.length; i++) {
    if (!points[i].lastPointOfContour) continue;
    const c = points.slice(start, i + 1);
    start = i + 1;
    let contour: (P | null)[] = c.map((p) => tr([p.x, p.y]));
    let on = c.map((p) => p.onCurve);
    const first = on.indexOf(true);
    if (first < 0) {
      contour.push(null);
      pen.qCurveTo(...contour);
    } else {
      contour = [...contour.slice(first + 1), ...contour.slice(0, first + 1)];
      on = [...on.slice(first + 1), ...on.slice(0, first + 1)];
      pen.moveTo(contour[contour.length - 1] as P);
      while (contour.length) {
        const next = on.indexOf(true) + 1;
        if (next === 1) {
          if (contour.length > 1) pen.lineTo(contour[0] as P);
        } else pen.qCurveTo(...contour.slice(0, next));
        contour = contour.slice(next);
        on = on.slice(next);
      }
    }
    pen.closePath();
  }
}


// --- fontTools-compatible instancer over opentype.js's parsed tables (fvar/avar/gvar/HVAR) ---
// opentype.js's own variation.getTransform rounds every delta to an integer and skips the F2Dot14 quantisation of the
// normalised location; fontTools keeps float coordinates, so we redo the point maths ourselves and keep opentype.js
// only as the parser (and for HVAR advances, which do match).
type Hdr = { peakTuple?: number[]; sharedTupleRecordsIndex: number; intermediateStartTuple?: number[]; intermediateEndTuple?: number[]; privatePoints: number[]; deltas: number[]; deltasY: number[] };
const otRound = (v: number) => Math.floor(v + 0.5);
const f2dot14 = (v: number) => otRound(v * 16384) / 16384;

function normalizeWght(f: any, wght: number): number {
  const { minValue: lo, defaultValue: def, maxValue: hi } = f.tables.fvar.axes[0];
  const v = Math.max(Math.min(wght, hi), lo);
  let n = v === def ? 0 : (v < def ? (v - def) / (def - lo) : (v - def) / (hi - def));
  const m: { fromCoordinate: number; toCoordinate: number }[] = f.tables.avar.axisSegmentMaps[0].axisValueMaps;
  const hit = m.find((e) => e.fromCoordinate === n);
  if (hit) n = hit.toCoordinate;
  else if (n < m[0].fromCoordinate) n = n + m[0].toCoordinate - m[0].fromCoordinate;
  else if (n > m[m.length - 1].fromCoordinate) n = n + m[m.length - 1].toCoordinate - m[m.length - 1].fromCoordinate;
  else {
    const a = [...m].reverse().find((e) => e.fromCoordinate < n)!;
    const b = m.find((e) => e.fromCoordinate > n)!;
    n = a.toCoordinate + ((b.toCoordinate - a.toCoordinate) * (n - a.fromCoordinate)) / (b.fromCoordinate - a.fromCoordinate);
  }
  return f2dot14(n);
}

// fontTools.varLib.models.supportScalar, single axis, ot=True.
function supportScalar(v: number, lower: number, peak: number, upper: number): number {
  if (peak === 0 || lower > peak || peak > upper || (lower < 0 && upper > 0) || v === peak) return 1;
  if (v <= lower || upper <= v) return 0;
  return v < peak ? (v - lower) / (peak - lower) : (v - upper) / (peak - upper);
}

// fontTools.varLib.iup.iup_segment / iup_contour, one contour.
function iupSegment(coords: P[], rc1: P, rd1: P, rc2: P, rd2: P): P[] {
  const out: number[][] = [[], []];
  for (let j = 0; j < 2; j++) {
    let x1 = rc1[j], x2 = rc2[j], d1 = rd1[j], d2 = rd2[j];
    if (x1 === x2) { for (let i = 0; i < coords.length; i++) out[j].push(d1 === d2 ? d1 : 0); continue; }
    if (x1 > x2) { [x1, x2] = [x2, x1]; [d1, d2] = [d2, d1]; }
    const scale = (d2 - d1) / (x2 - x1);
    for (const c of coords) {
      const x = c[j];
      if (x <= x1) out[j].push(d1);
      else if (x >= x2) out[j].push(d2);
      else { const nudge = (x - x1) * scale; out[j].push(d1 + nudge); }
    }
  }
  return out[0].map((_, i) => [out[0][i], out[1][i]] as P);
}
function iupContour(deltas: (P | null)[], coords: P[]): P[] {
  if (!deltas.includes(null)) return deltas as P[];
  const n = deltas.length;
  const idx = deltas.flatMap((d, i) => (d ? [i] : []));
  if (!idx.length) return deltas.map(() => [0, 0] as P);
  const out: P[] = [];
  let start = idx[0];
  if (start !== 0) out.push(...iupSegment(coords.slice(0, start), coords[start], deltas[start]!, coords[idx[idx.length - 1]], deltas[idx[idx.length - 1]]!));
  out.push(deltas[start]!);
  for (const end of idx.slice(1)) {
    if (end - start > 1) out.push(...iupSegment(coords.slice(start + 1, end), coords[start], deltas[start]!, coords[end], deltas[end]!));
    out.push(deltas[end]!);
    start = end;
  }
  if (start !== n - 1) out.push(...iupSegment(coords.slice(start + 1, n), coords[start], deltas[start]!, coords[idx[0]], deltas[idx[0]]!));
  return out;
}

function instancePoints(f: any, glyphIndex: number, v: number): Pt[] {
  const base: Pt[] = f.glyphs.get(glyphIndex).points ?? [];
  const gv = f.tables.gvar;
  const data = gv.glyphVariations[glyphIndex];
  if (!data || !base.length) return base;
  const orig: P[] = base.map((p) => [p.x, p.y]);
  let acc: P[] | null = null;
  for (const h of data.headers as Hdr[]) {
    const peak = (h.peakTuple ?? gv.sharedTuples[h.sharedTupleRecordsIndex])[0];
    const lower = h.intermediateStartTuple ? h.intermediateStartTuple[0] : Math.min(0, peak);
    const upper = h.intermediateEndTuple ? h.intermediateEndTuple[0] : Math.max(0, peak);
    const scalar = peak === 0 ? 1 : (lower <= peak && peak <= upper && !(lower < 0 && upper > 0)) ? supportScalar(v, lower, peak, upper) : 0;
    if (!scalar) continue;
    const pts = h.privatePoints.length ? h.privatePoints : data.sharedPoints;
    let d: (P | null)[];
    if (!pts.length) d = orig.map((_, i) => [h.deltas[i], h.deltasY[i]] as P);
    else { d = orig.map(() => null); pts.forEach((pi: number, k: number) => { if (pi < d.length) d[pi] = [h.deltas[k], h.deltasY[k]]; }); }
    let full: P[] = [];
    let s = 0;
    base.forEach((p, i) => { if (p.lastPointOfContour) { full.push(...iupContour(d.slice(s, i + 1), orig.slice(s, i + 1))); s = i + 1; } });
    if (scalar !== 1) full = full.map(([x, y]) => [x * scalar, y * scalar] as P);
    acc = acc ? acc.map(([x, y], i) => [x + full[i][0], y + full[i][1]] as P) : full;
  }
  if (!acc) return base;
  return base.map((p, i) => ({ ...p, x: p.x + acc![i][0], y: p.y + acc![i][1] }));
}

// banner.py reopens the file per instance; do the same so HVAR mutation of glyph widths never leaks.
const inst = (buf: Buffer, wght: number) => {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const f: any = ot.parse(ab); // no type declarations ship with opentype.js 2.0.0 (see opentype.d.ts)
  const v = normalizeWght(f, wght);
  const glyph = (ch: string) => {
    const gi = f.charToGlyphIndex(ch);
    if (gi === 0) throw new Error(`no glyph for ${ch}`);
    const adv = f.variation.getTransform(f.glyphs.get(gi), { wght }).advanceWidth as number;
    return { advanceWidth: adv, points: instancePoints(f, gi, v) };
  };
  return { glyph, upm: f.unitsPerEm as number };
};


function textPath(f: ReturnType<typeof inst>, text: string, size: number, cx: number, baseline: number, tracking = 0) {
  const scale = size / f.upm;
  const gl = [...text].map((c) => f.glyph(c));
  const width = gl.reduce((s, g) => s + g.advanceWidth, 0) * scale + tracking * (gl.length - 1);
  let x = cx - width / 2;
  const pen = new Pen();
  for (const g of gl) {
    const x0 = x;
    const points = g.points;
    drawGlyph(points, pen, ([px, py]) => [scale * px + 0 * py + x0, 0 * px + -scale * py + baseline]);
    x += g.advanceWidth * scale + tracking;
  }
  return { d: pen.out.join(""), width };
}

const SKULL = "M12,2A9,9 0 0,0 3,11C3,14.03 4.53,16.82 7,18.47V22H9V19H11V22H13V19H15V22H17V18.46C19.47,16.81 21,14 21,11A9,9 0 0,0 12,2M8,11A2,2 0 0,1 10,13A2,2 0 0,1 8,15A2,2 0 0,1 6,13A2,2 0 0,1 8,11M16,11A2,2 0 0,1 18,13A2,2 0 0,1 16,15A2,2 0 0,1 14,13A2,2 0 0,1 16,11M12,14L13.5,17H10.5L12,14Z";
const W = 1000, H = 240;

const THEMES = {
  dark: { bg: "#180D10", panel: "#281216", gold: "#C5A15A", rule: "#C5A15A", text: "#C5A15A", sub: "#E8DDC5", motto: "#C5A15A", red: "#791E29", scan: "#C5A15A", beam: ".10" },
  light: { bg: "#E8DDC5", panel: "#DCCBA8", gold: "#8C6D2E", rule: "#8C6D2E", text: "#791E29", sub: "#281216", motto: "#281216", red: "#791E29", scan: "#791E29", beam: ".05" },
};

// Python f-string of a float: whole values print "120.0" (JS prints "120"); other values share the shortest-repr digits.
const pf = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));
function svg(t: (typeof THEMES)["dark"], title: string, sub: string, motto: string, tw: number) {
  const half = tw / 2;
  const lx = W / 2 - half - 70, rx = W / 2 + half + 22;
  const rules = ([[90, 300, 300], [700, 910, 700]] as const)
    .map(([a, b, d]) => `<path d="M${a},144H${b}" stroke="${t.rule}" stroke-width="1.5"/>` + `<path d="M${d},139l5,5l-5,5l-5,-5z" fill="${t.gold}"/>`)
    .join("");
  const rivets = [22, W - 22].flatMap((x) => [22, H - 22].map((y) => `<circle cx="${x}" cy="${y}" r="4" fill="${t.gold}"/>`)).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t">
<title id="t">Strategium: an orchestrator workflow for omp. The Captain plans, the squads build, you keep the seals.</title>
<style>
.scan{animation:sweep 6s linear infinite}
@keyframes sweep{from{transform:translateX(-160px)}to{transform:translateX(${W + 160}px)}}
@media (prefers-reduced-motion:reduce){.scan{animation:none;opacity:0}}
</style>
<defs>
<linearGradient id="beam" x1="0" x2="1"><stop offset="0" stop-color="${t.scan}" stop-opacity="0"/><stop offset=".5" stop-color="${t.scan}" stop-opacity="${t.beam}"/><stop offset="1" stop-color="${t.scan}" stop-opacity="0"/></linearGradient>
<clipPath id="frame"><rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="6"/></clipPath>
</defs>
<rect x="8" y="8" width="${W - 16}" height="${H - 16}" rx="6" fill="${t.bg}" stroke="${t.rule}" stroke-width="2"/>
<rect x="34" y="34" width="${W - 68}" height="${H - 68}" fill="${t.panel}" stroke="${t.rule}" stroke-width="1" stroke-dasharray="2 4"/>
<g clip-path="url(#frame)"><rect class="scan" x="0" y="8" width="160" height="${H - 16}" fill="url(#beam)"/></g>
${rivets}
<path d="M8,${pf(H / 2)}h18M${W - 26},${pf(H / 2)}h18" stroke="${t.red}" stroke-width="4"/>
<g fill="${t.gold}">
<path transform="translate(${pf(lx)},72) scale(2)" d="${SKULL}"/>
<path transform="translate(${pf(rx)},72) scale(2)" d="${SKULL}"/>
</g>
<path fill="${t.text}" d="${title}"/>
${rules}
<path fill="${t.sub}" d="${sub}"/>
<path fill="${t.motto}" d="${motto}"/>
</svg>
`;
}
if (import.meta.main) {
  const [fontPath, outDir] = process.argv.slice(2);
  if (!fontPath || !outDir) {
    console.error("usage: bun tools/banner/banner.ts <Cinzel[wght].ttf> <outdir>");
    process.exit(1);
  }
  const buf = readFileSync(fontPath);
  const bold = inst(buf, 800);
  const reg = inst(buf, 500);
  const { d: title, width: tw } = textPath(bold, "STRATEGIUM", 74, W / 2, 124, 10);
  const { d: sub } = textPath(reg, "AN ORCHESTRATOR WORKFLOW FOR OMP", 19, W / 2, 175, 5);
  const { d: motto } = textPath(reg, "THE CAPTAIN PLANS · THE SQUADS BUILD · YOU KEEP THE SEALS", 13, W / 2, 199, 3);
  for (const [name, t] of Object.entries(THEMES)) writeFileSync(`${outDir}/banner-${name}.svg`, svg(t, title, sub, motto, tw));
}
