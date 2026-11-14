import { useEffect, useRef, type CSSProperties } from 'react';
import { ACC_DIM, clear, GLYPHS, makeGrid, TONES, type Grid, type Pointer, type Scene } from './ascii';

/** Opacity of each tone (index 0 is "nothing"): six strengths of ink, then three of the accent. */
const ALPHA = [0, 0.1, 0.19, 0.32, 0.52, 0.74, 0.96, 0.42, 0.74, 1];
const FONT = '"Geist Mono", ui-monospace, "SFMono-Regular", Menlo, monospace';
const FRAME_MS = 1000 / 30;
/** The moment shown when the visitor has asked for reduced motion. */
const STILL_AT = 7.5;

/** Glyph code → column in the sprite sheet. Every glyph used is below U+0400. */
const GLYPH_COLUMN = new Int16Array(1024).fill(-1);
for (let i = 0; i < GLYPHS.length; i++) GLYPH_COLUMN[GLYPHS.charCodeAt(i)] = i;

interface Instance {
  visible: boolean;
  last: number;
  draw: (seconds: number) => void;
}

// One animation loop for every ASCII canvas on the page; canvases that are off screen are skipped.
const live = new Set<Instance>();
let frame = 0;
function tick(now: number) {
  frame = live.size ? requestAnimationFrame(tick) : 0;
  if (document.hidden) return;
  for (const inst of live) {
    if (!inst.visible || now - inst.last < FRAME_MS) continue;
    inst.last = now;
    inst.draw(now / 1000);
  }
}

interface Props {
  scene: Scene;
  /** Colours as "r,g,b". */
  ink: string;
  accent: string;
  /** Light glyphs on a dark page. */
  dark?: boolean;
  fontPx?: number;
  /** Let the scene follow the pointer while it is over this element's parent. */
  interactive?: boolean;
  /** Seconds added to the clock, so two canvases with the same scene do not move in step. */
  offset?: number;
  style?: CSSProperties;
}

/**
 * Draws a scene from `ascii.ts` as a grid of characters. The glyphs are pre-rendered once per
 * colour and size into a sprite sheet and copied into place each frame, which is far cheaper
 * than drawing text and keeps the font's ligatures from joining neighbouring cells.
 */
export default function AsciiCanvas({ scene, ink, accent, dark = false, fontPx = 12, interactive = false, offset = 0, style }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = wrap.current;
    const cv = canvas.current;
    const ctx = cv?.getContext('2d');
    if (!host || !cv || !ctx) return;

    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let grid: Grid | null = null;
    let sheet: HTMLCanvasElement | null = null;
    let cellW = 0;
    let cellH = 0;
    // Where the pointer is, and where the scene is told it is: the second follows the first
    // smoothly, and drifts back to the middle when the pointer leaves.
    let target: Pointer | null = null;
    let eased: Pointer | null = null;

    const layout = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width < 4 || height < 4) return;
      const probe = document.createElement('canvas').getContext('2d');
      if (!probe) return;
      probe.font = `500 ${fontPx}px ${FONT}`;
      // Whole device pixels per cell, so glyphs land on the pixel grid and stay sharp.
      cellW = Math.max(2, Math.round(probe.measureText('M').width * dpr));
      cellH = Math.max(2, Math.round(fontPx * 1.2 * dpr));
      const cols = Math.max(1, Math.floor((width * dpr) / cellW));
      const rows = Math.max(1, Math.floor((height * dpr) / cellH));
      cv.width = cols * cellW;
      cv.height = rows * cellH;
      cv.style.width = `${cv.width / dpr}px`;
      cv.style.height = `${cv.height / dpr}px`;
      grid = makeGrid(cols, rows, cellW / dpr, cellH / dpr, dark);

      sheet = document.createElement('canvas');
      sheet.width = GLYPHS.length * cellW;
      sheet.height = (TONES - 1) * cellH;
      const sctx = sheet.getContext('2d');
      if (!sctx) return;
      sctx.font = `500 ${fontPx * dpr}px ${FONT}`;
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      for (let tone = 1; tone < TONES; tone++) {
        sctx.fillStyle = `rgba(${tone >= ACC_DIM ? accent : ink},${ALPHA[tone]})`;
        for (let i = 0; i < GLYPHS.length; i++) sctx.fillText(GLYPHS[i], i * cellW + cellW / 2, (tone - 1) * cellH + cellH / 2);
      }
      draw(still ? STILL_AT : performance.now() / 1000);
    };

    const draw = (seconds: number) => {
      if (!grid || !sheet) return;
      clear(grid);
      if (interactive) {
        const midX = (grid.cols * grid.cw) / 2;
        const midY = (grid.rows * grid.ch) / 2;
        eased ??= { x: midX, y: midY };
        eased.x += ((target?.x ?? midX) - eased.x) * 0.07;
        eased.y += ((target?.y ?? midY) - eased.y) * 0.07;
      }
      scene(grid, (still ? STILL_AT : seconds) + offset, eased);
      ctx.clearRect(0, 0, cv.width, cv.height);
      const { cols, rows, chars, tones } = grid;
      for (let r = 0, i = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++, i++) {
          const tone = tones[i];
          if (tone === 0) continue;
          const col = GLYPH_COLUMN[chars[i]];
          if (col < 0) continue;
          ctx.drawImage(sheet, col * cellW, (tone - 1) * cellH, cellW, cellH, c * cellW, r * cellH, cellW, cellH);
        }
      }
    };

    layout();
    // The grid is measured from the font, so measure again once the web font has arrived.
    void document.fonts?.load(`500 ${fontPx}px "Geist Mono"`).then(layout, () => undefined);
    const resize = new ResizeObserver(layout);
    resize.observe(host);

    const inst: Instance = { visible: false, last: 0, draw };
    const seen = new IntersectionObserver(([e]) => { inst.visible = e.isIntersecting; }, { rootMargin: '80px' });
    seen.observe(host);
    if (!still) {
      live.add(inst);
      if (!frame) frame = requestAnimationFrame(tick);
    }

    const area = interactive && !still ? host.parentElement : null;
    const move = (e: PointerEvent) => {
      const box = cv.getBoundingClientRect();
      target = { x: e.clientX - box.left, y: e.clientY - box.top };
    };
    const leave = () => { target = null; };
    area?.addEventListener('pointermove', move);
    area?.addEventListener('pointerleave', leave);

    return () => {
      live.delete(inst);
      resize.disconnect();
      seen.disconnect();
      area?.removeEventListener('pointermove', move);
      area?.removeEventListener('pointerleave', leave);
    };
  }, [scene, ink, accent, dark, fontPx, interactive, offset]);

  return (
    <div ref={wrap} aria-hidden="true" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', pointerEvents: 'none', ...style }}>
      <canvas ref={canvas} style={{ display: 'block', flexShrink: 0 }} />
    </div>
  );
}
