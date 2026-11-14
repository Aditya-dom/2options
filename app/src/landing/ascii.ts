/**
 * ASCII scenes for the landing page. Each scene paints glyphs into a grid of character cells;
 * `AsciiCanvas` draws the grid. A scene is a function of the grid, the time and the pointer only
 * (no DOM, no clock of its own), so what it draws at a given moment is a value that can be tested.
 *
 * Geometry is done in pixels, because a character cell is taller than it is wide: a slope that
 * looks diagonal on screen is not one cell across per cell down.
 */

/** How strongly a cell is drawn. The renderer maps each tone to a colour and an opacity. */
export const NONE = 0;
export const GHOST = 1;
export const FAINT = 2;
export const DIM = 3;
export const MID = 4;
export const STRONG = 5;
export const BRIGHT = 6;
/** The accent colour (NEAR green), at three strengths. Everything from here up is accent. */
export const ACC_DIM = 7;
export const ACC = 8;
export const ACC_BRIGHT = 9;
export const TONES = 10;

/** Which tone wins when two things land on one cell. */
const RANK = [0, 1, 2, 3, 4, 6, 8, 5, 7, 9];

/** Every glyph a scene may use. The renderer pre-draws exactly these. */
export const GLYPHS = " .·:'¯-_/\\|~=+*#%@o°ΔΓ0123456789abcdefghijklmnopqrstuvwxyz";

export interface Grid {
  cols: number;
  rows: number;
  /** Cell size in pixels. */
  cw: number;
  ch: number;
  /** Light glyphs on a dark page. Shaded solids put their ink where the light is, or is not. */
  dark: boolean;
  /** One character code and one tone per cell, row by row. */
  chars: Uint16Array;
  tones: Uint8Array;
}

/** Where the pointer is, in pixels from the grid's top left corner. */
export interface Pointer { x: number; y: number }
export type Scene = (g: Grid, t: number, pointer: Pointer | null) => void;

export function makeGrid(cols: number, rows: number, cw: number, ch: number, dark = false): Grid {
  return { cols, rows, cw, ch, dark, chars: new Uint16Array(cols * rows), tones: new Uint8Array(cols * rows) };
}

export function clear(g: Grid): void {
  g.tones.fill(NONE);
}

/** Write one cell if it is inside the grid and the new tone outranks what is there. */
export function put(g: Grid, c: number, r: number, glyph: string, tone: number): void {
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return;
  const i = r * g.cols + c;
  if (RANK[tone] < RANK[g.tones[i]]) return;
  g.chars[i] = glyph.charCodeAt(0);
  g.tones[i] = tone;
}

/** Write one cell whatever is there: for something passing in front. */
function set(g: Grid, c: number, r: number, glyph: string, tone: number): void {
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return;
  const i = r * g.cols + c;
  g.chars[i] = glyph.charCodeAt(0);
  g.tones[i] = tone;
}

/** Write one cell only if nothing is there yet: for a background. */
function fill(g: Grid, c: number, r: number, glyph: string, tone: number): void {
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return;
  const i = r * g.cols + c;
  if (g.tones[i] !== NONE) return;
  g.chars[i] = glyph.charCodeAt(0);
  g.tones[i] = tone;
}

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const x = clamp01(v); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** 4x4 ordered-dither threshold in (0, 1): turns a brightness into a stipple density. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const dither = (c: number, r: number) => (BAYER[(r & 3) * 4 + (c & 3)] + 0.5) / 16;

/** Glyphs from least ink to most: an amount of ink picks one. */
const SHADE = '.:-=+*#%@';
/** The same with fewer steps, for small drawings, where many kinds of glyph read as noise. */
const SHADE_SMALL = '.:=+#%';
const shadeGlyph = (ink: number, ramp = SHADE) => ramp[Math.min(ramp.length - 1, Math.floor(clamp01(ink) * ramp.length))];
const INK = [GHOST, FAINT, DIM, MID, STRONG, BRIGHT];
const inkTone = (b: number) => INK[Math.min(INK.length - 1, Math.floor(clamp01(b) * INK.length))];

/**
 * Ink for a surface catching `light` (0 dark, 1 fully lit). On a white page the shadows carry
 * the ink, as in a pencil drawing; on a dark page the lit side does.
 */
const inkFor = (g: Grid, light: number) => (g.dark ? 0.1 + 0.9 * clamp01(light) : 0.08 + 0.86 * Math.pow(1 - clamp01(light), 1.15));

/** The light every solid on the page is lit by: above, to the left, in front. */
const LIGHT = (() => { const v = [-0.46, -0.6, 0.66]; const n = Math.hypot(v[0], v[1], v[2]); return [v[0] / n, v[1] / n, v[2] / n]; })();

/**
 * The glyph for a stroke passing through a cell. `dx`, `dy` are the stroke's direction in pixels
 * (y down); `frac` is how far down the cell it passes (0 top, 1 bottom). Flat strokes pick a
 * glyph by height, so a gentle curve reads as `_.-'¯` instead of a staircase.
 */
export function strokeGlyph(dx: number, dy: number, frac: number): string {
  const steep = Math.abs(dy) / (Math.abs(dx) + 1e-9);
  if (steep > 2.6) return '|';
  if (steep > 0.55) return dx * dy < 0 ? '/' : '\\';
  if (frac < 0.2) return '¯';
  if (frac < 0.4) return "'";
  if (frac < 0.6) return '-';
  if (frac < 0.8) return '.';
  return '_';
}

function text(g: Grid, c: number, r: number, s: string, tone: number): void {
  for (let i = 0; i < s.length; i++) if (s[i] !== ' ') put(g, c + i, r, s[i], tone);
}

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Hero: an infinity sign as a solid, lit and turning, with a light that goes round it for ever
   ───────────────────────────────────────────────────────────────────────────────────────────── */

const LOOP_N = 720;
/** How tall the lobes are, and how far apart the two strands are where they cross. */
const LOBE = 0.95;
const CROSSING = 0.17;

/** The loop's centre line at unit size, with two unit vectors across it at every point. */
const LOOP = (() => {
  const p = new Float32Array(LOOP_N * 3);
  const a = new Float32Array(LOOP_N * 3);
  const b = new Float32Array(LOOP_N * 3);
  const at = (q: number) => {
    const s = Math.sin(q);
    const den = 1 + s * s;
    return [Math.cos(q) / den, (LOBE * s * Math.cos(q)) / den, CROSSING * s];
  };
  for (let k = 0; k < LOOP_N; k++) {
    const q = (k / LOOP_N) * TAU;
    const here = at(q);
    const p0 = at(q - 1e-3);
    const p1 = at(q + 1e-3);
    let tx = p1[0] - p0[0];
    let ty = p1[1] - p0[1];
    let tz = p1[2] - p0[2];
    const tl = Math.hypot(tx, ty, tz);
    tx /= tl; ty /= tl; tz /= tl;
    const al = Math.hypot(ty, tx);
    const ax = ty / al;
    const ay = -tx / al;
    p.set(here, k * 3);
    a.set([ax, ay, 0], k * 3);
    b.set([-tz * ay, tz * ax, tx * ay - ty * ax], k * 3);
  }
  return { p, a, b };
})();

const FAR = -1e9;
interface Buffers { size: number; depth: Float32Array; light: Float32Array; along: Float32Array }
let buffers: Buffers | null = null;

/** Where the headline and its line of text end, so the art stays clear of them. */
export const textBottom = (W: number, H: number) => H * 0.14 + (W > 700 ? 275 : 225);

export const paintHero: Scene = (g, t, pointer) => {
  const { cols, rows, cw, ch } = g;
  const W = cols * cw;
  const H = rows * ch;
  const cx = W / 2;
  const top = textBottom(W, H) + ch * 2;
  const room = H - top - ch * 3.4;
  // On screen it is a little taller than its half-width `A`, more when it rocks.
  const A = Math.min(W * (W > 700 ? 0.36 : 0.42), room / 1.12);
  // Where the width is what limits it (a phone), it sits in the middle of the room it has.
  const cy = top + Math.max(A * 0.56, room / 2 - ch);
  const solid = A > ch * 5;

  if (solid) {
    const rho = Math.max(A * 0.1, ch * 1.5) / A;
    // Seen from a little above, it rocks from side to side, nods, and leans towards the pointer.
    const lean = pointer ? clamp01(pointer.x / W) * 2 - 1 : 0;
    const nod = pointer ? clamp01(pointer.y / H) * 2 - 1 : 0;
    const alpha = 0.3 * Math.sin(t * 0.31) + 0.2 * lean;
    const beta = -(0.36 + 0.05 * Math.sin(t * 0.23) + 0.06 * nod);
    const sa = Math.sin(alpha);
    const ca = Math.cos(alpha);
    const sb = Math.sin(beta);
    const cb = Math.cos(beta);
    const eye = A * 4.6;

    const size = cols * rows;
    if (buffers?.size !== size) buffers = { size, depth: new Float32Array(size), light: new Float32Array(size), along: new Float32Array(size) };
    const { depth, light, along } = buffers;
    depth.fill(FAR);

    // Enough samples that no cell the tube covers is missed.
    const stride = Math.max(1, Math.floor(LOOP_N / Math.ceil((A * 5.6) / (cw * 0.45))));
    const around = Math.max(12, Math.ceil((TAU * rho * A) / (cw * 0.45)));
    const cosA = new Float32Array(around);
    const sinA = new Float32Array(around);
    for (let j = 0; j < around; j++) { cosA[j] = Math.cos((j / around) * TAU); sinA[j] = Math.sin((j / around) * TAU); }
    // Halfway between the light and the eye: where the highlight sits.
    const hl = Math.hypot(LIGHT[0], LIGHT[1], LIGHT[2] + 1);
    const hx = LIGHT[0] / hl;
    const hy = LIGHT[1] / hl;
    const hz = (LIGHT[2] + 1) / hl;

    const turn = (v: Float32Array, k: number, out: number[]) => {
      const x = v[k], y = v[k + 1], z = v[k + 2];
      const x1 = x * ca + z * sa;
      const z1 = -x * sa + z * ca;
      out[0] = x1;
      out[1] = y * cb - z1 * sb;
      out[2] = y * sb + z1 * cb;
    };
    const P = [0, 0, 0];
    const N1 = [0, 0, 0];
    const N2 = [0, 0, 0];
    for (let k = 0; k < LOOP_N; k += stride) {
      turn(LOOP.p, k * 3, P);
      turn(LOOP.a, k * 3, N1);
      turn(LOOP.b, k * 3, N2);
      const s = k / LOOP_N;
      // Bands of light and shade run along the tube, so it is seen to flow.
      const band = 0.86 + 0.14 * Math.sin(TAU * (s * 18 - t * 0.2));
      for (let j = 0; j < around; j++) {
        const nx = cosA[j] * N1[0] + sinA[j] * N2[0];
        const ny = cosA[j] * N1[1] + sinA[j] * N2[1];
        const nz = cosA[j] * N1[2] + sinA[j] * N2[2];
        if (nz < -0.12) continue; // facing away
        const pz = (P[2] + rho * nz) * A;
        const scale = eye / (eye - pz);
        const c = Math.floor((cx + (P[0] + rho * nx) * A * scale) / cw);
        const r = Math.floor((cy + (P[1] + rho * ny) * A * scale) / ch);
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        const i = r * cols + c;
        if (pz <= depth[i]) continue;
        depth[i] = pz;
        const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        const shine = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 22);
        light[i] = (0.08 + 0.8 * diffuse) * band + 0.4 * shine;
        along[i] = s;
      }
    }

    // A cell on the outline, or where the near strand passes over the far one, is inked in.
    const step = rho * A * 1.1;
    const head = (t * 0.08) % 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const d = depth[i];
        if (d === FAR) continue;
        const rim = c === 0 || c === cols - 1 || r === 0 || r === rows - 1
          || depth[i - 1] < d - step || depth[i + 1] < d - step || depth[i - cols] < d - step || depth[i + cols] < d - step;
        let ink = inkFor(g, light[i]);
        if (rim) ink = Math.max(ink, g.dark ? 0.5 : 0.7);
        const behind = (head - along[i] + 1) % 1;
        const glow = behind < 0.16 ? 1 - behind / 0.16 : 0;
        if (glow > 0) set(g, c, r, shadeGlyph(Math.max(ink, 0.45)), glow > 0.62 ? ACC_BRIGHT : glow > 0.28 ? ACC : ACC_DIM);
        else set(g, c, r, shadeGlyph(ink), inkTone(0.18 + 0.82 * ink));
      }
    }

    // Two sparks circle it, passing behind and in front.
    for (let n = 0; n < 2; n++) {
      for (let j = 9; j >= 0; j--) {
        const q = t * 0.4 + n * Math.PI - j * 0.035;
        const x = 1.2 * Math.cos(q);
        const y = 0.1 * Math.sin(2 * q);
        const z = 0.62 * Math.sin(q);
        const x1 = x * ca + z * sa;
        const z1 = -x * sa + z * ca;
        const pz = (y * sb + z1 * cb) * A;
        const scale = eye / (eye - pz);
        const c = Math.floor((cx + x1 * A * scale) / cw);
        const r = Math.floor((cy + (y * cb - z1 * sb) * A * scale) / ch);
        if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
        if (pz < depth[r * cols + c]) continue;
        if (j === 0) set(g, c, r, n ? '*' : 'o', n ? BRIGHT : ACC_BRIGHT);
        else fill(g, c, r, '·', n ? (j < 4 ? MID : FAINT) : j < 4 ? ACC : ACC_DIM);
      }
    }

    // Its shadow on the floor.
    const floorY = Math.min(H - ch * 1.7, cy + A * 0.56 + ch * 1.4);
    const reachX = (A + rho * A) * (0.6 + 0.4 * Math.abs(ca));
    for (let r = Math.floor((floorY - ch * 1.6) / ch); r <= Math.floor((floorY + ch * 1.6) / ch); r++) {
      for (let c = 0; c < cols; c++) {
        const shade = 1 - (((c + 0.5) * cw - cx) / reachX) ** 2 - (((r + 0.5) * ch - floorY) / (ch * 1.7)) ** 2;
        if (shade > 0 && shade * 0.85 > dither(c, r)) fill(g, c, r, shade > 0.6 ? ':' : '·', shade > 0.6 ? DIM : FAINT);
      }
    }
  }

  // The page behind it: a lattice of dots, and a ripple spreading out from the solid.
  const ripple = ((t * 0.06) % 1) * Math.hypot(W / 2, H) * 1.05;
  for (let r = 1; r < rows; r += 2) {
    for (let c = 2; c < cols; c += 4) {
      const d = Math.hypot((c + 0.5) * cw - cx, (r + 0.5) * ch - cy);
      const wave = Math.abs(d - ripple);
      fill(g, c, r, '·', wave < ch * 1.2 ? DIM : wave < ch * 3 ? FAINT : GHOST);
    }
  }
};

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Feature illustrations
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Everlasting options: a moon that never stops circling. The orbit is marked in twenty-four
 * hours, and each one lights as the moon passes it, as funding does.
 */
export const paintOrbit: Scene = (g, t) => {
  const { cols, rows, cw, ch } = g;
  const W = cols * cw;
  const H = rows * ch;
  const cx = W / 2;
  const cy = H * 0.5;
  const R = H * 0.42;
  const within = (x: number, y: number) => (x - cx) ** 2 + (y - cy) ** 2 < R * R;

  // The planet: a lit sphere.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cw;
      const y = (r + 0.5) * ch;
      if (!within(x, y)) continue;
      const nx = (x - cx) / R;
      const ny = (y - cy) / R;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const light = 0.06 + 0.94 * Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
      const rim = !within(x - cw, y) || !within(x + cw, y) || !within(x, y - ch) || !within(x, y + ch);
      let ink = inkFor(g, light);
      if (rim) ink = Math.max(ink, g.dark ? 0.4 : 0.55);
      put(g, c, r, shadeGlyph(ink, SHADE_SMALL), inkTone(0.2 + 0.8 * ink));
    }
  }

  // The orbit, tilted: its far half goes behind the planet, its near half in front.
  const N = 192;
  const rx = W * 0.47;
  const ry = rx * 0.25;
  const roll = -0.2;
  const moon = (t * 0.07) % 1;
  for (let k = 0; k < N; k++) {
    const q = (k / N) * TAU;
    const ex = rx * Math.cos(q);
    const ey = ry * Math.sin(q);
    const x = cx + ex * Math.cos(roll) - ey * Math.sin(roll);
    const y = cy + ex * Math.sin(roll) + ey * Math.cos(roll);
    const near = Math.sin(q) > 0;
    if (!near && within(x, y)) continue;
    const c = Math.floor(x / cw);
    const r = Math.floor(y / ch);
    const behind = (moon - k / N + 1) % 1;
    const draw = near ? set : put;
    if (k % 8 === 0) draw(g, c, r, 'o', behind < 0.1 ? ACC_BRIGHT : behind < 0.2 ? ACC : behind < 0.3 ? ACC_DIM : near ? MID : DIM);
    else if (!near || !within(x, y)) fill(g, c, r, '·', near ? DIM : FAINT);
  }
  const mq = moon * TAU;
  const mx = cx + rx * Math.cos(mq) * Math.cos(roll) - ry * Math.sin(mq) * Math.sin(roll);
  const my = cy + rx * Math.cos(mq) * Math.sin(roll) + ry * Math.sin(mq) * Math.cos(roll);
  if (Math.sin(mq) > 0 || !within(mx, my)) {
    const c = Math.floor(mx / cw);
    const r = Math.floor(my / ch);
    set(g, c, r, '@', ACC_BRIGHT);
    set(g, c - 1, r, '#', ACC);
    set(g, c + 1, r, '#', ACC);
  }
};

const RIDGES = 9;
const RIDGE_TONES = [BRIGHT, ACC_BRIGHT, BRIGHT, STRONG, STRONG, MID, MID, DIM, DIM];
/** The ridge in the accent colour, and the one the readout is taken from. */
const LIVE_RIDGE = 1;

/**
 * Real-time Greeks: gamma across strikes, one ridge behind another, moving as the market does.
 * A ridge hides what is behind and below it.
 */
export const paintRidges: Scene = (g, t) => {
  const { cols, rows, cw, ch } = g;
  const W = cols * cw;
  const horizon = new Float64Array(cols).fill(Infinity);
  const spot = 0.5 + 0.2 * Math.sin(t * 0.43);
  let live = (_x: number) => 0;
  let liveGamma = 0;

  for (let k = 0; k < RIDGES; k++) {
    // Each baseline sits low in its row, so a flat stretch is a ruled line of underscores.
    const base = (rows - 2.08 - k) * ch;
    const shift = (k - (RIDGES - 1) / 2) * cw * 1.7;
    const centre = 0.5 + 0.08 * Math.sin(t * 0.37 + k * 0.55);
    const width = 0.115 + 0.03 * Math.sin(t * 0.29 + k * 0.4);
    const amp = ch * (3.2 + 1.5 * Math.sin(t * 0.52 - k * 0.75));
    const bell = (u: number) => Math.exp(-0.5 * ((u - centre) / width) ** 2);
    const ridge = (x: number) => {
      const u = (x - shift) / W;
      const e = bell(u);
      return base - amp * e - ch * 0.07 * e * Math.sin(u * 34 + k * 1.9 + t * 2.1);
    };
    if (k === LIVE_RIDGE) { live = ridge; liveGamma = bell(spot); }
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cw;
      if (x - shift < cw * 2.5 || x - shift > W - cw * 2.5) continue;
      const y = ridge(x);
      if (y >= horizon[c] - ch * 0.5) continue;
      const r = Math.floor(y / ch);
      put(g, c, r, strokeGlyph(cw, ridge(x + cw / 2) - ridge(x - cw / 2), y / ch - r), RIDGE_TONES[k]);
      // The ridge has a body: stipple under the line, down to its foot or to the ridge in front.
      for (let rr = r + 1; (rr + 0.5) * ch < Math.min(base - ch * 0.6, horizon[c]); rr++) {
        const shade = 0.75 - 0.5 * (((rr + 0.5) * ch - y) / amp);
        if (shade > dither(c, rr)) fill(g, c, rr, ':', k === LIVE_RIDGE ? ACC_DIM : k < 4 ? DIM : FAINT);
      }
      horizon[c] = y;
    }
  }

  // Spot rides the live ridge; the readout follows it.
  const shift = (LIVE_RIDGE - (RIDGES - 1) / 2) * cw * 1.7;
  const sx = spot * W + shift;
  set(g, Math.floor(sx / cw), Math.floor(live(sx) / ch), 'o', ACC_BRIGHT);
  const delta = clamp01(0.5 + 1.5 * (spot - 0.5));
  const label = `Δ ${delta.toFixed(2)}   Γ ${(0.004 + 0.014 * liveGamma).toFixed(3)}`;
  const c0 = Math.floor((cols - label.length) / 2);
  text(g, c0, rows - 1, label, STRONG);
  text(g, c0, rows - 1, 'Δ', ACC_BRIGHT);
  text(g, c0 + label.indexOf('Γ'), rows - 1, 'Γ', ACC_BRIGHT);
};

/** Payoff at expiry of the four strategies the page names, over a price range of [-1, 1]. */
const STRATEGIES: readonly { name: string; payoff: (u: number) => number }[] = [
  { name: 'straddle', payoff: u => Math.abs(u) * 1.65 - 0.6 },
  { name: 'strangle', payoff: u => Math.max(0, Math.abs(u) - 0.36) * 2.4 - 0.48 },
  { name: 'call spread', payoff: u => clamp01((u + 0.3) * 1.7) * 1.15 - 0.45 },
  { name: 'risk reversal', payoff: u => (Math.abs(u) > 0.3 ? Math.sign(u) * (Math.abs(u) - 0.3) * 1.4 : 0) },
];
const PAYOFF_PERIOD = 3.6;

/** Multi-leg strategies: profit and loss by price, one strategy folding into the next. */
export const paintPayoff: Scene = (g, t) => {
  const { cols, rows, cw, ch } = g;
  const W = cols * cw;
  const plotRows = rows - 2;
  const axisRow = Math.round(plotRows * 0.6);
  const axisY = (axisRow + 0.5) * ch;
  const scale = (axisY - ch * 0.4) / 1.06;
  const phase = t / PAYOFF_PERIOD;
  const from = STRATEGIES[Math.floor(phase) % STRATEGIES.length];
  const to = STRATEGIES[(Math.floor(phase) + 1) % STRATEGIES.length];
  const k = smooth(((phase % 1) - 0.6) / 0.4); // hold, then fold
  const x0 = W * 0.04;
  const x1 = W * 0.96;
  const lowest = (plotRows - 0.4) * ch;
  const curve = (x: number) => {
    const u = ((x - x0) / (x1 - x0)) * 2 - 1;
    return Math.min(lowest, axisY - scale * lerp(from.payoff(u), to.payoff(u), k));
  };
  const c0 = Math.ceil(x0 / cw);
  const c1 = Math.floor(x1 / cw) - 1;

  // A bar per price: profit in the accent colour above the axis, loss in grey below it.
  for (let c = c0; c <= c1; c++) {
    const x = (c + 0.5) * cw;
    const y = curve(x);
    const r = Math.floor(y / ch);
    const profit = y < axisY;
    for (let rr = Math.min(r, axisRow) + 1; rr < Math.max(r, axisRow); rr++) {
      const near = 1 - Math.abs((rr + 0.5) * ch - y) / Math.max(ch, Math.abs(axisY - y));
      put(g, c, rr, '|', profit ? (near > 0.5 ? ACC : ACC_DIM) : near > 0.5 ? MID : DIM);
    }
    put(g, c, axisRow, c & 1 ? '-' : ' ', MID);
    if (r !== axisRow) put(g, c, r, strokeGlyph(cw, curve(x + cw / 2) - curve(x - cw / 2), y / ch - r), BRIGHT);
  }

  // Strikes: where the line bends.
  const bend = (c: number) => Math.abs(curve((c + 1.5) * cw) - 2 * curve((c + 0.5) * cw) + curve((c - 0.5) * cw));
  for (let c = c0 + 1; c < c1; c++) {
    const here = bend(c);
    if (here > ch * 0.2 && here >= bend(c - 1) && here > bend(c + 1)) set(g, c, Math.floor(curve((c + 0.5) * cw) / ch), 'o', ACC_BRIGHT);
  }

  const name = k < 0.5 ? from.name : to.name;
  text(g, Math.floor((cols - name.length) / 2), rows - 1, name, Math.abs(k - 0.5) < 0.2 ? DIM : STRONG);
};

/** Non-custodial: a padlock, lit as a solid, with a scan passing over it and a live keyhole. */
export const paintLock: Scene = (g, t) => {
  const { cols, rows, cw, ch } = g;
  const W = cols * cw;
  const H = rows * ch;
  const cx = W / 2;
  const bw = Math.min(W * 0.5, H * 1.06);
  const bh = H * 0.5;
  const top = H * 0.45;
  const left = cx - bw / 2;
  const corner = ch * 0.95;
  const rx = bw * 0.3;
  const ry = H * 0.38;

  /** How lit the lock is at a pixel, or -1 where there is no lock. */
  const lock = (x: number, y: number): number => {
    if (x >= left && x <= left + bw && y >= top && y <= top + bh) {
      const qx = Math.max(left + corner - x, x - (left + bw - corner), 0);
      const qy = Math.max(top + corner - y, y - (top + bh - corner), 0);
      if (qx * qx + qy * qy > corner * corner) return -1;
      // A slab curving away to the right and downward.
      return 0.92 - 0.62 * ((x - left) / bw) - 0.24 * ((y - top) / bh);
    }
    if (y < top) {
      const e = Math.hypot((x - cx) / rx, (y - top) / ry);
      if (Math.abs(e - 1) < 0.2) return 0.85 - 0.6 * ((x - (cx - rx * 1.2)) / (rx * 2.4)) - 1.4 * Math.max(0, e - 1);
    }
    return -1;
  };

  const scanY = ((t * 0.22) % 1.4 - 0.2) * H;
  const kc = Math.floor(cx / cw);
  const kr = Math.floor((top + bh * 0.42) / ch);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cw;
      const y = (r + 0.5) * ch;
      const light = lock(x, y);
      if (light < 0) continue;
      // The plate round the keyhole is left clear.
      if (Math.hypot((c - kc) * cw, (r - kr - 0.5) * ch * 0.8) < ch * 1.55) continue;
      const rim = lock(x - cw, y) < 0 || lock(x + cw, y) < 0 || lock(x, y - ch) < 0 || lock(x, y + ch) < 0;
      let ink = inkFor(g, light);
      if (rim) ink = Math.max(ink, g.dark ? 0.5 : 0.66);
      const lit = Math.abs(y - scanY) < ch * 0.8;
      if (lit) put(g, c, r, shadeGlyph(Math.max(ink, 0.5), SHADE_SMALL), rim ? ACC_BRIGHT : ACC);
      else put(g, c, r, shadeGlyph(ink, SHADE_SMALL), inkTone(0.2 + 0.8 * ink));
    }
  }
  put(g, kc, kr, Math.sin(t * 2.4) > -0.3 ? '@' : 'o', ACC_BRIGHT);
  put(g, kc, kr + 1, '|', ACC_BRIGHT);
};

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Divider: a dotted rule with a light running along it
   ───────────────────────────────────────────────────────────────────────────────────────────── */

const COMET = '#*+=--··';

export const paintDivider: Scene = (g, t) => {
  const row = Math.floor(g.rows / 2);
  for (let c = 0; c < g.cols; c += 2) put(g, c, row, '·', FAINT);
  const head = Math.floor((((t * 0.085) % 1) * 1.3 - 0.15) * g.cols);
  for (let j = 0; j < COMET.length * 2; j++) {
    const glyph = COMET[Math.min(COMET.length - 1, j >> 1)];
    put(g, head - j, row, glyph, j < 3 ? ACC_BRIGHT : j < 8 ? ACC : ACC_DIM);
  }
};

/* ─────────────────────────────────────────────────────────────────────────────────────────────
   Band: a strip of sea across the page, two swells passing each other, drawn in small characters
   ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The page's border. A near swell, filled and brightest along its crest, travels one way in
 * front of a fainter one going the other. The edge of each is drawn by how much of a cell the
 * water covers, so the outline is smooth even though the cells are coarse. A light runs along
 * the near crest.
 */
export const paintBand: Scene = (g, t) => {
  const { cols, rows, cw, ch } = g;
  const W = cols * cw;
  const H = rows * ch;
  const near = (x: number) => H * 0.56 + H * 0.27 * Math.sin((TAU * (x - t * ch * 1.1)) / (H * 3.4)) + H * 0.07 * Math.sin((TAU * (x + t * ch * 0.5)) / (H * 1.3));
  const far = (x: number) => H * 0.4 + H * 0.24 * Math.sin((TAU * (x + t * ch * 0.7)) / (H * 2.3) + 1.9);
  const tail = Math.max(cw * 16, W * 0.12);
  const head = (((t * 0.04) % 1) * 1.3 - 0.15) * W;

  for (let c = 0; c < cols; c++) {
    const x = (c + 0.5) * cw;
    const yn = near(x);
    const yf = far(x);
    const behind = head - x;
    const lit = behind >= 0 && behind < tail;
    for (let r = 0; r < rows; r++) {
      const bottom = (r + 1) * ch;
      const covered = clamp01((bottom - yn) / ch); // how much of this cell the near swell fills
      if (covered > 0.12) {
        const depth = Math.max(0, (r + 0.5) * ch - yn) / H;
        const ink = covered * (0.96 - 0.62 * depth);
        // The light sits on the crest: the top two rows of water.
        if (lit && depth < (1.6 * ch) / H) set(g, c, r, shadeGlyph(Math.max(ink, 0.3)), behind < tail * 0.3 ? ACC_BRIGHT : behind < tail * 0.7 ? ACC : ACC_DIM);
        else set(g, c, r, shadeGlyph(ink), inkTone(0.16 + 0.84 * ink));
        continue;
      }
      const back = clamp01((bottom - yf) / ch);
      if (back > 0.2) set(g, c, r, back < 0.6 ? '.' : ':', DIM);
    }
  }
};
