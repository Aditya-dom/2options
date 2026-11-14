import { Info } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../theme';

const HIDDEN = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden',
  clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
} as const;

/**
 * An (i) that explains on hover, on keyboard focus, or on tap. The text is always in the page
 * (visually hidden, and the icon's description for screen readers), so disclosures never
 * disappear from it; the bubble only shows it.
 */
export default function InfoTip({ children, label = 'More information', width = 340 }: {
  children: ReactNode; label?: string; width?: number;
}) {
  const { t } = useTheme();
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);

  const show = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8));
    const up = r.bottom + 200 > window.innerHeight && r.top > 200;
    setPos({ left, top: up ? r.top - 6 : r.bottom + 6, up });
  };
  const hide = () => setPos(null);

  useEffect(() => {
    if (!pos) return;
    const close = (e: Event) => { if (!btn.current?.contains(e.target as Node)) hide(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('scroll', hide, true);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('scroll', hide, true);
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [pos]);

  return (
    <>
      <button ref={btn} type="button" aria-label={label} aria-describedby={id}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
        onClick={() => (pos ? hide() : show())}
        style={{ display: 'inline-flex', alignItems: 'center', background: 'transparent', border: 'none', padding: 2, margin: 0, cursor: 'help', color: pos ? t.ACCENT : t.DIM, verticalAlign: 'middle' }}>
        <Info size={13} />
      </button>
      <span id={id} style={HIDDEN}>{children}</span>
      {pos && createPortal(
        <div role="tooltip" aria-hidden="true" style={{
          position: 'fixed', left: pos.left, width, zIndex: 70,
          ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }),
          background: t.PANEL, color: t.WHITE, border: `1px solid ${t.ACCENT}`, boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
          padding: '10px 12px', fontFamily: t.MONO, fontSize: 11, lineHeight: 1.6, letterSpacing: 0, textTransform: 'none',
          pointerEvents: 'none', whiteSpace: 'normal',
        }}>{children}</div>,
        document.body,
      )}
    </>
  );
}
