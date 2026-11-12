import { ChevronDown } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from '../theme';

export interface SelectOption<T extends string | number> {
  value: T;
  label: ReactNode;
  /** Right-aligned note, e.g. "ATM". */
  hint?: ReactNode;
}

/**
 * A themed dropdown in place of the native <select>, whose menu ignores the app's theme and fonts.
 * The menu is portalled and fixed-positioned, so it is not clipped by scrolling tables or panels.
 * Keyboard: Enter/Space/ArrowDown opens; arrows move; Enter picks; Escape or Tab closes.
 */
export default function Select<T extends string | number>({ value, options, onChange, ariaLabel, style, menuWidth }: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  ariaLabel: string;
  style?: CSSProperties;
  menuWidth?: number;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const selected = Math.max(0, options.findIndex(o => o.value === value));

  const place = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const up = below < 260 && r.top > below;
    setPos({ top: up ? r.top : r.bottom, left: r.left, width: r.width, up });
  };

  const show = () => { place(); setActive(selected); setOpen(true); };
  const close = (refocus = true) => { setOpen(false); if (refocus) button.current?.focus(); };
  const pick = (i: number) => { const o = options[i]; if (o) onChange(o.value); close(); };

  useLayoutEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!button.current?.contains(n) && !list.current?.contains(n)) close(false);
    };
    // The menu is fixed-positioned: follow the button when the page scrolls, close if it leaves.
    const scroll = (e: Event) => { if (!list.current?.contains(e.target as Node)) place(); };
    document.addEventListener('mousedown', outside);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); show(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active); }
  };

  const current = options[selected];
  return (
    <>
      <button ref={button} type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open}
        onClick={() => (open ? close() : show())} onKeyDown={onKey}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer',
          fontFamily: t.MONO, fontSize: 11, color: t.WHITE, background: t.MUTED, padding: '4px 8px',
          border: `1px solid ${open ? t.ACCENT : t.BORDER}`, borderRadius: 2, minWidth: 0, whiteSpace: 'nowrap', ...style,
        }}>
        <span className="tabular-nums" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{current?.label ?? '—'}</span>
        <ChevronDown size={12} style={{ flexShrink: 0, color: t.GRAY, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.12s' }} />
      </button>
      {open && pos && createPortal(
        <div ref={list} role="listbox" aria-label={ariaLabel}
          style={{
            position: 'fixed', left: pos.left, width: Math.max(pos.width, menuWidth ?? 0), zIndex: 60,
            ...(pos.up ? { bottom: window.innerHeight - pos.top + 2 } : { top: pos.top + 2 }),
            maxHeight: 260, overflowY: 'auto', background: t.PANEL, border: `1px solid ${t.LINE}`,
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)', fontFamily: t.MONO, fontSize: 11,
          }}>
          {options.map((o, i) => {
            const isSel = i === selected;
            return (
              <div key={String(o.value)} data-i={i} role="option" aria-selected={isSel}
                onMouseEnter={() => setActive(i)} onMouseDown={e => { e.preventDefault(); pick(i); }}
                style={{
                  display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 10px', cursor: 'pointer',
                  color: isSel ? t.ACCENT : t.WHITE, fontWeight: isSel ? 700 : 400,
                  background: i === active ? t.ACCENT_BG : 'transparent',
                  boxShadow: isSel ? `inset 2px 0 0 ${t.ACCENT}` : 'none',
                }}>
                <span className="tabular-nums">{o.label}</span>
                {o.hint != null && <span style={{ color: t.DIM, fontSize: 9, letterSpacing: '0.1em', alignSelf: 'center' }}>{o.hint}</span>}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
