import { X } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { useTheme } from '../theme';

export function Dialog({ title, onClose, children, width = 400 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const { t } = useTheme();
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}
        style={{ width: '100%', maxWidth: width, maxHeight: '100%', overflowY: 'auto', background: t.PANEL, border: `1px solid ${t.BORDER}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: `1px solid ${t.BORDER}` }}>
          <span style={{ fontFamily: t.MONO, fontSize: 10, letterSpacing: '0.16em', color: t.ACCENT }}>{title}</span>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: t.GRAY, cursor: 'pointer' }}><X size={14} /></button>
        </div>
        <div style={{ padding: 14, display: 'grid', gap: 10 }}>{children}</div>
      </div>
    </div>
  );
}

export function Panel({ title, right, children, style, bodyStyle }: {
  title: string; right?: ReactNode; children: ReactNode; style?: CSSProperties; bodyStyle?: CSSProperties;
}) {
  const { t } = useTheme();
  return (
    <section style={{ background: t.PANEL, border: `1px solid ${t.BORDER}`, display: 'flex', flexDirection: 'column', minWidth: 0, ...style }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px',
        borderBottom: `1px solid ${t.BORDER}`, fontFamily: t.MONO, fontSize: 10, letterSpacing: '0.16em', color: t.ACCENT,
      }}>
        <span>{title}</span>
        {right}
      </header>
      <div style={{ padding: 12, minWidth: 0, ...bodyStyle }}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  const { t } = useTheme();
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.14em', color: t.DIM, textTransform: 'uppercase' }}>{label}</div>
      <div className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 15, fontWeight: 600, color: color ?? t.WHITE, marginTop: 3, overflowWrap: 'anywhere' }}>{value}</div>
      {sub != null && <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.GRAY, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

type Variant = 'primary' | 'buy' | 'sell' | 'ghost';

export function Button({ children, onClick, variant = 'primary', disabled, style, title, type = 'button' }: {
  children: ReactNode; onClick?: () => void; variant?: Variant; disabled?: boolean; style?: CSSProperties; title?: string;
  type?: 'button' | 'submit';
}) {
  const { t } = useTheme();
  const palette: Record<Variant, { fg: string; bg: string; border: string }> = {
    primary: { fg: t.ACCENT, bg: t.ACCENT_BG, border: t.ACCENT },
    buy: { fg: t.GREEN, bg: t.GREEN_BG, border: t.GREEN },
    sell: { fg: t.RED, bg: t.RED_BG, border: t.RED },
    ghost: { fg: t.GRAY, bg: 'transparent', border: t.BORDER },
  };
  const c = palette[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        fontFamily: t.MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', padding: '8px 12px',
        color: disabled ? t.DIM : c.fg, background: disabled ? 'transparent' : c.bg,
        border: `1px solid ${disabled ? t.BORDER : c.border}`, cursor: disabled ? 'not-allowed' : 'pointer',
        borderRadius: 2, transition: 'opacity 0.12s', ...style,
      }}
    >
      {children}
    </button>
  );
}

export function AmountInput({ value, onChange, suffix, placeholder, onMax, ariaLabel }: {
  value: string; onChange: (v: string) => void; suffix?: string; placeholder?: string; onMax?: () => void; ariaLabel: string;
}) {
  const { t } = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', border: `1px solid ${t.BORDER}`, background: t.MUTED }}>
      <input
        aria-label={ariaLabel}
        inputMode="decimal"
        value={value}
        placeholder={placeholder ?? '0.00'}
        onChange={e => onChange(e.target.value.replace(/[^\d.]/g, ''))}
        style={{
          flex: 1, minWidth: 0, background: 'transparent', border: 'none', color: t.WHITE,
          fontFamily: t.MONO, fontSize: 14, padding: '9px 10px', outline: 'none',
        }}
      />
      {onMax && (
        <button type="button" onClick={onMax} style={{
          fontFamily: t.MONO, fontSize: 10, color: t.ACCENT, background: 'transparent', border: 'none',
          padding: '0 8px', cursor: 'pointer', letterSpacing: '0.08em',
        }}>MAX</button>
      )}
      {suffix && <span style={{ alignSelf: 'center', padding: '0 10px', fontFamily: t.MONO, fontSize: 11, color: t.DIM }}>{suffix}</span>}
    </div>
  );
}

export function Badge({ children, color }: { children: ReactNode; color: string }) {
  const { t } = useTheme();
  return (
    <span style={{
      fontFamily: t.MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color,
      border: `1px solid ${color}`, padding: '2px 6px', borderRadius: 2, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

export function Row({ label, value, color }: { label: ReactNode; value: ReactNode; color?: string }) {
  const { t } = useTheme();
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontFamily: t.MONO, fontSize: 11, padding: '3px 0' }}>
      <span style={{ color: t.GRAY }}>{label}</span>
      <span className="tabular-nums" style={{ color: color ?? t.WHITE, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

export function Note({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'error' }) {
  const { t } = useTheme();
  const c = tone === 'error' ? t.RED : tone === 'warn' ? t.ORANGE : t.ACCENT;
  return (
    <div style={{ fontFamily: t.MONO, fontSize: 11, lineHeight: 1.5, color: c, border: `1px solid ${c}`, background: 'transparent', padding: '8px 10px', opacity: 0.95 }}>
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  const { t } = useTheme();
  return <div style={{ fontFamily: t.MONO, fontSize: 11, color: t.DIM, padding: '18px 0', textAlign: 'center' }}>{children}</div>;
}
