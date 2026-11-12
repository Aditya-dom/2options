import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type UIEvent } from 'react';
import type { ChainRow } from '../backend/types';
import type { Series, Side, Underlying } from '../lib/contract';
import { flashClass, useFlash } from '../hooks/useFlash';
import { useProtocol } from '../hooks/useProtocol';
import { FUNDING_SCALE, fmtPremium, fmtSize, fmtSpot, SPOT_SCALE } from '../lib/units';
import { useTheme } from '../theme';
import { fmtDuration, useFundingCountdown } from './FundingPanel';

export interface Pick { series: string; side: Side }

const fmtDelta = (d: number) => (Math.abs(d) < 0.0005 ? '0.000' : d.toFixed(3));

/** Funding a long pays per contract per hour, USDC micros (rate × mark). */
export const fundingPerHour = (row: ChainRow) => (row.fundingRateHourly * row.mark) / FUNDING_SCALE;

const COLS = ['Bid', 'Mark', 'Ask', 'Delta', 'IV', 'Fund/h', 'Position'] as const;
/**
 * Column widths, the same on both sides so calls and puts overflow (and scroll) by the same
 * amount. When a side has room to spare the columns share it out; when it has too little, the
 * side scrolls instead of clipping a column by a few pixels.
 */
const COL_W: Record<(typeof COLS)[number], number> = { Bid: 78, Mark: 78, Ask: 78, Delta: 66, IV: 60, 'Fund/h': 74, Position: 72 };
const SIDE_MIN_W = COLS.reduce((sum, c) => sum + COL_W[c], 0);

/** Layout: the strike panel's width, and the fixed heights that keep the three panels' rows aligned. */
const STRIKE_W = 96;
const BAND_H = 24;
const HEAD_H = 24;
const ROW_H = 28;

/** A number cell that pulses green or red when the number shown changes; the text keeps the colour of its last move. */
function FlashCell({ value, text, base, style }: { value: number | null | undefined; text: string; base: string; style: CSSProperties }) {
  const { t } = useTheme();
  const { dir, key } = useFlash(value, text);
  return (
    <td key={key} className={`tabular-nums price-cell ${flashClass(dir)}`}
      style={{ ...style, color: dir === 'up' ? t.GREEN : dir === 'down' ? t.RED : base }}>
      {text}
    </td>
  );
}

/** The bid or ask button: flashes on change, and stays green (bid) or red (ask). */
function FlashPrice({ value, text, color, selected, usable, label, onClick }: {
  value: number | null | undefined; text: string; color: string; selected: boolean; usable: boolean; label?: string; onClick: () => void;
}) {
  const { t } = useTheme();
  const { dir, key } = useFlash(value, text);
  const tint = color === t.GREEN ? t.GREEN_BG : t.RED_BG;
  return (
    <td style={{ padding: '0 2px' }}>
      <button
        disabled={!usable}
        onClick={onClick}
        aria-label={label}
        aria-pressed={selected}
        className="tabular-nums"
        style={{
          width: '100%', height: 22, textAlign: 'right', fontFamily: t.MONO, fontSize: 11, fontWeight: 600, padding: 0,
          color: usable ? color : t.DIM, background: selected ? tint : 'transparent',
          border: `1px solid ${selected ? color : 'transparent'}`, cursor: usable ? 'pointer' : 'default', borderRadius: 2,
        }}
      >
        {/* The flash restarts by re-creating this span, so the button itself keeps keyboard focus. */}
        <span key={key} className={`price-cell ${flashClass(dir)}`} style={{ display: 'block', padding: '0 6px', lineHeight: '20px' }}>{text}</span>
      </button>
    </td>
  );
}

/** The last price in the toolbar, flashing on every tick. */
function Last({ spot }: { spot: bigint | undefined }) {
  const { t } = useTheme();
  const text = spot != null ? fmtSpot(spot) : '—';
  const { dir, key } = useFlash(spot == null ? null : Number(spot), text);
  return (
    <span key={key} className={`tabular-nums price-cell ${flashClass(dir)}`}
      style={{ fontFamily: t.MONO, fontSize: 13, fontWeight: 700, padding: '0 3px', borderRadius: 2, color: dir === 'up' ? t.GREEN : dir === 'down' ? t.RED : t.WHITE }}>
      {text}
    </span>
  );
}

/**
 * The option chain: toolbar, CALLS | STRIKE | PUTS, and a status line. Layout and styling
 * follow the earlier Pacifica frontend's OptionChainPanel; the data is the NEAR contract's
 * series and the agent's quotes.
 */
export default function OptionChain({ selected, onPick }: { selected: Pick | null; onPick: (p: Pick) => void }) {
  const { t } = useTheme();
  const { series, chain, spots, agentError, loaded, account } = useProtocol();
  const cd = useFundingCountdown();
  const underlyings = useMemo(() => [...new Set(series.map(s => s.underlying))], [series]);
  const [u, setU] = useState<Underlying | null>(null);
  const active = u && underlyings.includes(u) ? u : underlyings[0];
  const spot = active ? spots[active]?.price : undefined;
  const held = useMemo(() => new Map((account?.positions ?? []).map(p => [p.series, p.size])), [account]);

  const rows = useMemo(() => {
    const byStrike = new Map<bigint, { call?: Series; put?: Series }>();
    for (const s of series) {
      if (s.underlying !== active) continue;
      const r = byStrike.get(s.strike) ?? {};
      if (s.kind === 'Call') r.call = s; else r.put = s;
      byStrike.set(s.strike, r);
    }
    return [...byStrike.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [series, active]);

  // Three panels: calls | strike | puts. Calls and puts scroll as ONE sheet: the same sideways
  // offset on both, so they slide together in the same direction, behind a strike column that
  // stays put. Vertical scroll is shared by all three. Scrolling is the browser's own (with
  // trackpad momentum); each panel just copies its position to the others.
  const callsRef = useRef<HTMLDivElement>(null);
  const strikeRef = useRef<HTMLDivElement>(null);
  const putsRef = useRef<HTMLDivElement>(null);
  // Whether columns are hidden past the left or right edge, for the fades that say "more this way".
  const [edges, setEdges] = useState({ left: false, right: false });

  const updateEdges = () => {
    const calls = callsRef.current;
    if (!calls) return;
    const max = calls.scrollWidth - calls.clientWidth;
    const next = { left: calls.scrollLeft > 1, right: calls.scrollLeft < max - 1 };
    setEdges(e => (e.left === next.left && e.right === next.right ? e : next));
  };

  const onPanelScroll = (e: UIEvent<HTMLDivElement>) => {
    const src = e.currentTarget;
    const sides = [callsRef.current, putsRef.current];
    for (const el of [callsRef.current, strikeRef.current, putsRef.current]) {
      if (!el || el === src) continue;
      if (Math.abs(el.scrollTop - src.scrollTop) > 0.5) el.scrollTop = src.scrollTop;
      // Only calls and puts move sideways; the strike column never does.
      if (sides.includes(src) && sides.includes(el) && Math.abs(el.scrollLeft - src.scrollLeft) > 0.5) el.scrollLeft = src.scrollLeft;
    }
    updateEdges();
  };

  // A sideways swipe over the strike column still moves the sheet.
  useEffect(() => {
    const strike = strikeRef.current;
    if (!strike) return;
    const onWheel = (e: WheelEvent) => {
      const dx = e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
      if (!dx || (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY))) return;
      e.preventDefault();
      if (callsRef.current) callsRef.current.scrollLeft += dx;
    };
    strike.addEventListener('wheel', onWheel, { passive: false });
    return () => strike.removeEventListener('wheel', onWheel);
  });

  const hasPrices = chain.size > 0;
  useLayoutEffect(updateEdges, [hasPrices, rows.length]);
  useLayoutEffect(() => {
    const calls = callsRef.current;
    if (!calls) return;
    const ro = new ResizeObserver(updateEdges);
    ro.observe(calls);
    return () => ro.disconnect();
  }, []);

  const atm = useMemo(() => {
    if (spot == null || rows.length === 0) return null;
    let best = rows[0][0];
    for (const [k] of rows) if ((k > spot ? k - spot : spot - k) < (best > spot ? best - spot : spot - best)) best = k;
    return best;
  }, [rows, spot]);

  const label = { fontFamily: t.MONO, fontSize: 10, letterSpacing: '0.08em', color: t.GRAY } as const;
  const cellBase = { fontFamily: t.MONO, fontSize: 11, textAlign: 'right', padding: '0 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', borderBottom: `1px solid ${t.BORDER}` } as const;

  /** Bid (you sell) is green and ask (you buy) is red, as on the old desk. */
  const priceCell = (s: Series | undefined, row: ChainRow | undefined, side: Side) => {
    const price = row ? (side === 'Buy' ? row.ask : row.bid) : null;
    // A zero bid is no market: selling there would earn nothing and only add margin.
    const usable = !!s?.active && price != null && (side === 'Buy' || price > 0n);
    return (
      <FlashPrice
        value={price == null ? null : Number(price)}
        text={price == null || (side === 'Sell' && price === 0n) ? '—' : fmtPremium(price)}
        color={side === 'Sell' ? t.GREEN : t.RED}
        selected={!!s && selected?.series === s.id && selected.side === side}
        usable={usable}
        label={s ? `${side} ${s.id}` : undefined}
        onClick={() => s && onPick({ series: s.id, side })}
      />
    );
  };

  /** One side of a row, in COLS order. `itm` cells are brighter, out-of-the-money ones dimmed. */
  const side = (s: Series | undefined, row: ChainRow | undefined, itm: boolean) => {
    const tone = itm ? t.GRAY : t.DIM;
    const pos = s ? held.get(s.id) : undefined;
    const num = (v: number | null | undefined, text: string, base = tone) => <FlashCell value={v} text={text} base={base} style={cellBase} />;
    return (
      <>
        {priceCell(s, row, 'Sell')}
        {num(row ? Number(row.mark) : null, row ? fmtPremium(row.mark) : '—', itm ? t.WHITE : t.GRAY)}
        {priceCell(s, row, 'Buy')}
        {num(row?.delta, row ? fmtDelta(row.delta) : '—')}
        {num(row?.iv, row?.iv != null ? `${(row.iv * 100).toFixed(1)}%` : '—')}
        {num(row ? Number(fundingPerHour(row)) : null, row ? fmtPremium(fundingPerHour(row)) : '—')}
        <td className="tabular-nums" style={{ ...cellBase, color: pos ? (pos > 0n ? t.GREEN : t.RED) : t.DIM }}>
          {pos ? `${pos > 0n ? '+' : '−'}${fmtSize(pos > 0n ? pos : -pos)}` : '—'}
        </td>
      </>
    );
  };

  /** Column header cell; sticky so it stays in view while rows scroll under it. */
  const head = (name: string) => (
    <th key={name} style={{
      ...label, position: 'sticky', top: BAND_H, zIndex: 3, background: t.BG, textAlign: 'right', padding: '0 8px', whiteSpace: 'nowrap',
      fontWeight: name === 'Bid' || name === 'Ask' ? 700 : 500, color: name === 'Bid' ? t.GREEN : name === 'Ask' ? t.RED : t.GRAY,
      borderBottom: `1px solid ${t.BORDER}`, height: HEAD_H, lineHeight: `${HEAD_H - 1}px`,
    }}>{name}</th>
  );

  /** The tinted CALLS / PUTS band. A solid layer sits under the tint so rows scrolling under it never show through. */
  const band = (text: string, color: string, tint: string) => (
    <th colSpan={COLS.length} style={{
      ...label, position: 'sticky', top: 0, zIndex: 3, height: BAND_H, lineHeight: `${BAND_H - 1}px`, fontWeight: 700, letterSpacing: '0.2em', padding: 0,
      color, backgroundColor: t.BG, backgroundImage: `linear-gradient(${tint}, ${tint})`, borderBottom: `1px solid ${color}`,
    }}>{text}</th>
  );

  const rowStyle = (idx: number, isAtm: boolean): CSSProperties => ({ height: ROW_H, background: isAtm ? t.ACCENT_BG : idx % 2 === 0 ? t.BG : t.MUTED });
  const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'separate', borderSpacing: 0 };
  const sideTable: CSSProperties = { ...tableStyle, tableLayout: 'fixed', minWidth: SIDE_MIN_W };
  const colgroup = <colgroup>{COLS.map(c => <col key={c} style={{ width: COL_W[c] }} />)}</colgroup>;
  const sidePanel: CSSProperties = { flex: 1, minWidth: 0, overflow: 'auto' };
  const fades = (
    <>
      {edges.left && <div aria-hidden className="chain-fade" style={{ left: 0, background: `linear-gradient(to right, ${t.BG}, transparent)` }} />}
      {edges.right && <div aria-hidden className="chain-fade" style={{ right: 0, background: `linear-gradient(to left, ${t.BG}, transparent)` }} />}
    </>
  );

  return (
    <section aria-label="Option chain" style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, flex: 1, background: t.BG }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderBottom: `1px solid ${t.BORDER}`, flexWrap: 'wrap' }}>
        <span style={label}>PAIR</span>
        {underlyings.length > 1 ? (
          <select aria-label="Underlying" value={active} onChange={e => setU(e.target.value as Underlying)}
            style={{ fontFamily: t.MONO, fontSize: 11, padding: '4px 8px', background: t.PANEL, color: t.WHITE, border: `1px solid ${t.BORDER2}` }}>
            {underlyings.map(x => <option key={x} value={x}>{x}/USD</option>)}
          </select>
        ) : (
          <span style={{ fontFamily: t.MONO, fontSize: 11, padding: '4px 8px', color: t.WHITE, border: `1px solid ${t.BORDER2}` }}>{active ?? '—'}/USD</span>
        )}
        <span style={label}>EXPIRY</span>
        <span style={{ fontFamily: t.MONO, fontSize: 11, padding: '4px 8px', color: t.WHITE, border: `1px solid ${t.BORDER2}` }}>Everlasting</span>
        <div style={{ flex: 1 }} />
        {cd && <><span style={label}>FUNDING IN</span><span className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 12, color: t.ORANGE }}>{fmtDuration(cd.msLeft)}</span></>}
        <span style={label}>LAST</span>
        <Last spot={spot} />
      </div>

      {agentError && (
        <div style={{ fontFamily: t.MONO, fontSize: 11, color: t.ORANGE, padding: '4px 10px', borderBottom: `1px solid ${t.BORDER}` }}>
          Agent unavailable: {agentError}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ ...label, flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: t.DIM }}>{loaded ? 'NO SERIES LISTED' : 'LOADING…'}</div>
      ) : (
        <div className="chain-panels" style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {/* CALLS: slides together with puts */}
          <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
          {fades}
          <div ref={callsRef} onScroll={onPanelScroll} className="chain-side" role="region" aria-label="Calls" tabIndex={0} style={sidePanel}>
            <table style={sideTable}>
              {colgroup}
              <thead>
                <tr>{band('◀ CALLS', t.GREEN, t.GREEN_BG)}</tr>
                <tr>{COLS.map(head)}</tr>
              </thead>
              <tbody>
                {rows.map(([strike, { call }], idx) => (
                  <tr key={strike.toString()} className="chain-row" style={rowStyle(idx, strike === atm)}>
                    {side(call, call && chain.get(call.id), spot != null && strike < spot)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>

          {/* STRIKE: fixed width, no sideways scroll; follows the other two vertically */}
          <div ref={strikeRef} onScroll={onPanelScroll} className="chain-strike" style={{
            width: STRIKE_W, flexShrink: 0, overflowY: 'auto', overflowX: 'hidden', borderLeft: `1px solid ${t.LINE}`, borderRight: `1px solid ${t.LINE}`,
          }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th title="Double-click to slide back to the start" onDoubleClick={() => { if (callsRef.current) callsRef.current.scrollLeft = 0; }} style={{
                    ...label, position: 'sticky', top: 0, zIndex: 3, height: BAND_H + HEAD_H, background: t.BG, textAlign: 'center', fontWeight: 700,
                    letterSpacing: '0.2em', color: t.ACCENT, borderBottom: `1px solid ${t.ACCENT}`, cursor: 'default',
                  }}>STRIKE</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([strike], idx) => (
                  <tr key={strike.toString()} style={rowStyle(idx, strike === atm)}>
                    <td className="tabular-nums" style={{
                      fontFamily: t.MONO, fontSize: 12, fontWeight: 700, textAlign: 'center', whiteSpace: 'nowrap',
                      color: strike === atm ? t.ACCENT : t.WHITE, borderBottom: `1px solid ${t.BORDER}`,
                    }}>{(strike / SPOT_SCALE).toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* PUTS: slides together with calls */}
          <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
          {fades}
          <div ref={putsRef} onScroll={onPanelScroll} className="chain-side" role="region" aria-label="Puts" tabIndex={0} style={sidePanel}>
            <table style={sideTable}>
              {colgroup}
              <thead>
                <tr>{band('PUTS ▶', t.RED, t.RED_BG)}</tr>
                <tr>{COLS.map(head)}</tr>
              </thead>
              <tbody>
                {rows.map(([strike, { put }], idx) => (
                  <tr key={strike.toString()} className="chain-row" style={rowStyle(idx, strike === atm)}>
                    {side(put, put && chain.get(put.id), spot != null && strike > spot)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        </div>
      )}

      <div style={{ ...label, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '6px 10px', borderTop: `1px solid ${t.BORDER}` }}>
        <span>{rows.length} STRIKES</span>
        <span>CLICK <span style={{ color: t.GREEN }}>BID</span> TO SELL · CLICK <span style={{ color: t.RED }}>ASK</span> TO BUY</span>
      </div>
    </section>
  );
}
