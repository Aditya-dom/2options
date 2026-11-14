/**
 * The app's ASCII layer: meters drawn in block characters, a braille spinner, text that
 * decodes through glyphs, and a small infinity mark for empty states. Same language as the
 * landing scenes (src/landing/ascii.ts). Motion stops when the system asks for reduced motion.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTheme } from '../theme';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Box and block glyphs need a font that has them; Geist Mono falls back cleanly to these. */
const GLYPH_FONT = "'Geist Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";

/**
 * A meter in block characters: filled cells `█`, the partial cell shaded `▓▒░`, the rest `·`.
 * `marks` (0..1) draw a `┃` at thresholds such as a liquidation ratio.
 */
export function AsciiMeter({ value, cells = 36, color, marks = [], size = 13, label }: {
  value: number; cells?: number; color?: string; marks?: number[]; size?: number; label?: string;
}) {
  const { t } = useTheme();
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const markCells = new Set(marks.map(m => Math.min(cells - 1, Math.max(0, Math.round(m * cells - 0.5)))));
  const exact = v * cells;
  const full = Math.floor(exact);
  const frac = exact - full;
  const partial = frac > 0.75 ? '▓' : frac > 0.45 ? '▒' : frac > 0.15 ? '░' : '';
  return (
    <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v * 100)} aria-label={label}
      style={{ display: 'grid', gridTemplateColumns: `repeat(${cells}, minmax(0, 1fr))`, fontFamily: GLYPH_FONT, fontSize: size, lineHeight: 1, userSelect: 'none' }}>
      {Array.from({ length: cells }, (_, i) => {
        const mark = markCells.has(i);
        const ch = mark ? '┃' : i < full ? '█' : i === full && partial ? partial : '·';
        const on = i < full || (i === full && partial !== '');
        return <span key={i} aria-hidden style={{ textAlign: 'center', color: mark ? t.WHITE : on ? (color ?? t.ACCENT) : t.BORDER2 }}>{ch}</span>;
      })}
    </div>
  );
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** A braille spinner, for anything that is waiting on the network. */
export function Spinner({ color, style }: { color?: string; style?: CSSProperties }) {
  const { t } = useTheme();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduced()) return;
    const id = setInterval(() => setI(n => (n + 1) % SPIN.length), 80);
    return () => clearInterval(id);
  }, []);
  return <span aria-hidden style={{ fontFamily: GLYPH_FONT, color: color ?? t.ACCENT, display: 'inline-block', width: '1ch', ...style }}>{SPIN[i]}</span>;
}

const NOISE = '▚▞░▒▓#%*+=-:.';

/**
 * Text that resolves from random glyphs into itself, left to right, once when it first
 * appears or when the text changes. Screen readers get the final text at once.
 */
export function Scramble({ text, ms = 520 }: { text: string; ms?: number }) {
  const [shown, setShown] = useState(text);
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (reduced() || started.current === text) { setShown(text); return; }
    started.current = text;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const settled = Math.floor(k * text.length);
      setShown(text.split('').map((c, i) => (i < settled || c === ' ' ? c : NOISE[(i * 7 + Math.floor(now / 45)) % NOISE.length])).join(''));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [text, ms]);
  return (
    <>
      <span aria-hidden>{shown}</span>
      <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{text}</span>
    </>
  );
}

/** The infinity sign in half blocks: the mark that sits on empty states. */
const INFINITY = [
  ' ▄▀▀▀▄     ▄▀▀▀▄ ',
  '█     ▀▄ ▄▀     █',
  '█     ▄▀ ▀▄     █',
  ' ▀▄▄▄▀     ▀▄▄▄▀ ',
];

export function GlyphMark({ size = 9 }: { size?: number }) {
  const { t } = useTheme();
  return (
    <pre aria-hidden style={{ margin: '0 auto 12px', fontFamily: GLYPH_FONT, fontSize: size, lineHeight: 1, color: t.BORDER2, textAlign: 'center', userSelect: 'none' }}>
      {INFINITY.map((row, r) => (
        <div key={r}>{row.split('').map((c, i) => (
          <span key={i} style={{ color: (i + r) % 9 === 0 && c !== ' ' ? t.ACCENT : undefined }}>{c}</span>
        ))}</div>
      ))}
    </pre>
  );
}

/** A dashed rule that fills the rest of a line: `╌╌╌╌`. */
export function AsciiRule({ color }: { color?: string }) {
  const { t } = useTheme();
  return (
    <span aria-hidden style={{ flex: 1, minWidth: 12, overflow: 'hidden', whiteSpace: 'nowrap', fontFamily: GLYPH_FONT, color: color ?? t.BORDER2, letterSpacing: '0.05em', userSelect: 'none' }}>
      {'╌'.repeat(240)}
    </span>
  );
}

const BEAT = '▁▁▁▁▂▁▁▃▇█▅▂▁▁▁▂▂▁▁▁▁▁';

/** A heartbeat drawn in block characters, scrolling while things are alive; flat when not. */
export function Pulse({ alive, color, cells = 28 }: { alive: boolean; color?: string; cells?: number }) {
  const { t } = useTheme();
  const [k, setK] = useState(0);
  useEffect(() => {
    if (!alive || reduced()) return;
    const id = setInterval(() => setK(n => n + 1), 110);
    return () => clearInterval(id);
  }, [alive]);
  const line = alive
    ? Array.from({ length: cells }, (_, i) => BEAT[(i + k) % BEAT.length]).join('')
    : '▁'.repeat(cells);
  return <span aria-hidden style={{ fontFamily: GLYPH_FONT, fontSize: 15, lineHeight: 1, letterSpacing: '-0.04em', color: color ?? t.ACCENT, userSelect: 'none' }}>{line}</span>;
}
