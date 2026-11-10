import { useMemo, useState } from 'react';
import type { ChainRow } from '../backend/types';
import type { Series, Side, Underlying } from '../lib/contract';
import { useProtocol } from '../hooks/useProtocol';
import { FUNDING_SCALE, fmtPremium, fmtSpot, SPOT_SCALE } from '../lib/units';
import { useTheme } from '../theme';
import { Empty, Panel } from './ui';

export interface Pick { series: string; side: Side }

const fmtDelta = (d: number) => (Math.abs(d) < 0.0005 ? '0.000' : d.toFixed(3));

/** Funding a long pays per contract per hour, USDC micros (rate × mark). */
export const fundingPerHour = (row: ChainRow) => (row.fundingRateHourly * row.mark) / FUNDING_SCALE;

export default function OptionChain({ selected, onPick }: { selected: Pick | null; onPick: (p: Pick) => void }) {
  const { t } = useTheme();
  const { series, chain, spots, agentError, loaded } = useProtocol();
  const underlyings = useMemo(() => [...new Set(series.map(s => s.underlying))], [series]);
  const [u, setU] = useState<Underlying | null>(null);
  const active = u && underlyings.includes(u) ? u : underlyings[0];
  const spot = active ? spots[active]?.price : undefined;

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

  const atm = useMemo(() => {
    if (spot == null || rows.length === 0) return null;
    let best = rows[0][0];
    for (const [k] of rows) if ((k > spot ? k - spot : spot - k) < (best > spot ? best - spot : spot - best)) best = k;
    return best;
  }, [rows, spot]);

  const th = (label: string, align: 'left' | 'right' | 'center' = 'right') => (
    <th style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.12em', color: t.DIM, fontWeight: 500, padding: '6px 8px', textAlign: align, whiteSpace: 'nowrap', borderBottom: `1px solid ${t.BORDER}` }}>{label}</th>
  );

  const priceCell = (s: Series | undefined, row: ChainRow | undefined, side: Side) => {
    const price = row ? (side === 'Buy' ? row.ask : row.bid) : null;
    const isSel = s && selected?.series === s.id && selected.side === side;
    const color = side === 'Buy' ? t.GREEN : t.RED;
    // A zero bid is no market: selling there would earn nothing and only add margin.
    const usable = s?.active && price != null && (side === 'Buy' || price > 0n);
    return (
      <td style={{ padding: 2 }}>
        <button
          disabled={!usable}
          onClick={() => s && onPick({ series: s.id, side })}
          title={s ? `${side} ${s.id}` : undefined}
          className="tabular-nums"
          style={{
            width: '100%', textAlign: 'right', fontFamily: t.MONO, fontSize: 12, padding: '5px 8px',
            color: usable ? color : t.DIM, background: isSel ? (side === 'Buy' ? t.GREEN_BG : t.RED_BG) : 'transparent',
            border: `1px solid ${isSel ? color : 'transparent'}`, cursor: usable ? 'pointer' : 'default', borderRadius: 2,
          }}
        >
          {price == null || (side === 'Sell' && price === 0n) ? '—' : fmtPremium(price)}
        </button>
      </td>
    );
  };

  const num = (v: string, dim = false) => (
    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 11, color: dim ? t.DIM : t.GRAY, textAlign: 'right', padding: '5px 8px', whiteSpace: 'nowrap' }}>{v}</td>
  );

  return (
    <Panel
      title="OPTION CHAIN · EVERLASTING"
      right={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {underlyings.length > 1 && underlyings.map(x => (
            <button key={x} onClick={() => setU(x)} style={{
              fontFamily: t.MONO, fontSize: 10, color: x === active ? t.ACCENT : t.GRAY, background: 'transparent',
              border: `1px solid ${x === active ? t.ACCENT : t.BORDER}`, padding: '2px 6px', cursor: 'pointer',
            }}>{x}</button>
          ))}
          {spot != null && <span className="tabular-nums" style={{ color: t.WHITE, letterSpacing: 0, fontSize: 11 }}>{active} {fmtSpot(spot)}</span>}
        </div>
      }
      bodyStyle={{ padding: 0 }}
    >
      {agentError && (
        <div style={{ fontFamily: t.MONO, fontSize: 11, color: t.ORANGE, padding: '8px 12px', borderBottom: `1px solid ${t.BORDER}` }}>
          Agent unavailable: {agentError}
        </div>
      )}
      {!loaded ? <Empty>Loading series…</Empty> : rows.length === 0 ? <Empty>No series listed yet.</Empty> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
            <thead>
              <tr>
                <th colSpan={4} style={{ fontFamily: t.MONO, fontSize: 10, color: t.GREEN, letterSpacing: '0.16em', padding: '8px 8px 2px', textAlign: 'left' }}>CALLS</th>
                <th />
                <th colSpan={4} style={{ fontFamily: t.MONO, fontSize: 10, color: t.RED, letterSpacing: '0.16em', padding: '8px 8px 2px', textAlign: 'right' }}>PUTS</th>
              </tr>
              <tr>
                {th('FUND/H')}{th('Δ')}{th('BID')}{th('ASK')}
                {th('STRIKE', 'center')}
                {th('BID')}{th('ASK')}{th('Δ')}{th('FUND/H')}
              </tr>
            </thead>
            <tbody>
              {rows.map(([strike, { call, put }]) => {
                const c = call && chain.get(call.id);
                const p = put && chain.get(put.id);
                const isAtm = strike === atm;
                return (
                  <tr key={strike.toString()} className="chain-row" style={{ borderBottom: `1px solid ${t.BORDER}` }}>
                    {num(c ? fmtPremium(fundingPerHour(c)) : '—', true)}
                    {num(c ? fmtDelta(c.delta) : '—')}
                    {priceCell(call, c, 'Sell')}
                    {priceCell(call, c, 'Buy')}
                    <td style={{
                      fontFamily: t.MONO, fontSize: 12, fontWeight: 700, textAlign: 'center', padding: '5px 12px',
                      color: isAtm ? t.ACCENT : t.WHITE, background: isAtm ? t.ACCENT_BG : t.MUTED, whiteSpace: 'nowrap',
                    }}>
                      {(strike / SPOT_SCALE).toLocaleString('en-US')}
                    </td>
                    {priceCell(put, p, 'Sell')}
                    {priceCell(put, p, 'Buy')}
                    {num(p ? fmtDelta(p.delta) : '—')}
                    {num(p ? fmtPremium(fundingPerHour(p)) : '—', true)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, padding: '8px 12px', borderTop: `1px solid ${t.BORDER}`, lineHeight: 1.5 }}>
        No expiry. Longs pay hourly funding (FUND/H, per contract) instead. Click a bid to sell, an ask to buy. You trade against the LP vault.
      </div>
    </Panel>
  );
}
