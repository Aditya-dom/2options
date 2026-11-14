import type { HedgeOrder, HedgeRow, HedgeStatus } from '../backend/types';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { useTheme } from '../theme';
import { fmtUsd } from '../lib/units';
import { Badge, Empty, Note, Panel, Row, Stat } from './ui';

/** A pass older than this means the hedger has stopped reporting. */
const STALE_MS = 60_000;

const signed = (v: number, digits = 4) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
/** Dollars with a sign, without showing a negative zero for a loss under half a cent. */
export const signedUsd = (v: number) => (Math.round(v * 100) < 0 ? '−' : '') + fmtUsd(Math.abs(Math.round(v * 100) / 100));
const explorer = (h: HedgeStatus) =>
  h.venue === 'hyperliquid' && h.account
    ? `https://app.hyperliquid${h.network === 'testnet' ? '-testnet' : ''}.xyz/explorer/address/${h.account}`
    : null;

/** What the panel says about one underlying, and how loudly. */
export function rowSummary(r: HedgeRow): { text: string; tone: 'ok' | 'warn' } {
  if (r.state === 'hold') return { text: `On hold: ${r.reason}`, tone: 'warn' };
  if (r.state === 'trade') return { text: 'Rebalancing', tone: 'ok' };
  if (r.state === 'balanced') return { text: 'Hedged', tone: 'ok' };
  return { text: 'Not hedged', tone: 'warn' };
}

/**
 * The agent's delta hedge. It lives in an exchange account the operator holds, outside the
 * contract, so this panel always says so and never adds its P&L to the vault's numbers.
 */
export default function HedgePanel() {
  const { hedge } = useProtocol();
  const now = useNow(5_000);
  return <HedgeView hedge={hedge} now={now} />;
}

/** The panel for a given status and clock, with no data fetching of its own. */
export function HedgeView({ hedge, now }: { hedge: HedgeStatus | null; now: number }) {
  const { t } = useTheme();

  if (!hedge) return null; // demo mode, or an agent that does not report a hedger
  const stale = hedge.enabled && hedge.updatedMs != null && now - hedge.updatedMs > STALE_MS;
  const link = explorer(hedge);
  const badge = !hedge.enabled ? <Badge color={t.GRAY}>OFF</Badge>
    : hedge.error || stale ? <Badge color={t.ORANGE}>NOT UPDATING</Badge>
    : <Badge color={t.GREEN}>{`LIVE · ${(hedge.venue ?? '').toUpperCase()} ${(hedge.network ?? '').toUpperCase()}`}</Badge>;

  return (
    <Panel title="DELTA HEDGE" right={badge}>
      {hedge.rows.length === 0 ? <Empty>No open interest to hedge.</Empty> : hedge.rows.map(r => {
        const sum = rowSummary(r);
        return (
          <div key={r.underlying} style={{ marginBottom: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 14 }}>
              <Stat label={`Target ${r.underlying}`} value={r.target != null ? signed(r.target) : '—'} sub="perp that offsets the vault" />
              <Stat label="Hedge position" value={r.position != null ? signed(r.position) : '—'} sub={hedge.enabled ? 'held on the venue' : 'no hedger running'} />
              <Stat label="Unhedged" value={r.gap != null ? signed(r.gap) : r.target != null && !hedge.enabled ? signed(r.target) : '—'}
                sub={r.venueMid != null && r.gap != null ? `≈ ${fmtUsd(Math.abs(r.gap) * r.venueMid, 0)}` : undefined}
                color={sum.tone === 'warn' ? t.ORANGE : t.WHITE} />
            </div>
            {hedge.enabled && (
              <div style={{ marginTop: 8 }}>
                <Row label="Status" value={sum.text} color={sum.tone === 'warn' ? t.ORANGE : t.GREEN} />
                {r.band != null && (
                  <Row label="Re-hedges when the gap passes"
                    value={`±${r.band.toFixed(4)} ${r.underlying}${r.venueMid != null ? ` (≈ ${fmtUsd(r.band * r.venueMid, 0)})` : ''}`} />
                )}
                {r.venueMid != null && <Row label="Venue price" value={`${fmtUsd(r.venueMid)}${r.basisBps != null ? ` (${signed(r.basisBps, 0)} bps vs contract spot)` : ''}`} />}
                {r.unrealizedPnl != null && <Row label="Hedge P&L, unrealized" value={signedUsd(r.unrealizedPnl)} />}
              </div>
            )}
          </div>
        );
      })}

      {hedge.enabled && (
        <div>
          {hedge.accountValue != null && <Row label="Collateral on the venue" value={fmtUsd(hedge.accountValue)} />}
          {hedge.account && (
            <Row label="Exchange account" value={link
              ? <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: t.ACCENT }}>{`${hedge.account.slice(0, 8)}…${hedge.account.slice(-6)}`}</a>
              : hedge.account} />
          )}
        </div>
      )}
      {hedge.error && <div style={{ marginTop: 10 }}><Note tone="warn">The hedger's last pass failed, so it sent no order: {hedge.error}</Note></div>}
      {!hedge.error && stale && <div style={{ marginTop: 10 }}><Note tone="warn">The hedger has not reported for over a minute. The position shown may be out of date.</Note></div>}

      {hedge.orders.length > 0 && <Orders orders={hedge.orders.slice(0, 8)} />}

      <div style={{ marginTop: 12 }}>
        <Note>
          {hedge.enabled
            ? <>The hedge is a perp position in an exchange account the operator holds, <b>not in the contract</b>. It lowers the price risk LPs carry. Its profit and loss is <b>not</b> part of the vault equity or share price shown here.
              {hedge.rehedgeMoveBps != null && hedge.deadbandUsd != null && <> Every re-hedge costs spread and fees, so the hedger waits until delta has drifted by what a {(hedge.rehedgeMoveBps / 100).toFixed(1)}% move in spot causes (at least {fmtUsd(hedge.deadbandUsd, 0)}); the vault carries that drift in between.</>}</>
            : <>Hedging is switched off on this agent, so LPs carry the vault's net delta. The target above is the perp position that would offset it.</>}
        </Note>
      </div>
    </Panel>
  );
}

function Orders({ orders }: { orders: HedgeOrder[] }) {
  const { t } = useTheme();
  const cell = (align: 'left' | 'right', color = t.GRAY) => ({ fontFamily: t.MONO, fontSize: 11, padding: '5px 6px', textAlign: align, color } as const);
  const statusColor = (o: HedgeOrder) => (o.status === 'filled' ? t.GREEN : o.status === 'rejected' ? t.RED : t.ORANGE);
  return (
    <div style={{ marginTop: 12, overflowX: 'auto' }}>
      <div style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.14em', color: t.DIM, marginBottom: 4 }}>RECENT HEDGE ORDERS</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {orders.map((o, i) => (
            <tr key={`${o.atMs}-${i}`} style={{ borderTop: `1px solid ${t.BORDER}` }} title={o.detail || undefined}>
              <td style={cell('left')}>{new Date(o.atMs).toLocaleTimeString()}</td>
              <td style={cell('left', o.side === 'buy' ? t.GREEN : t.RED)}>{o.side.toUpperCase()}{o.reduceOnly ? ' (reduce)' : ''}</td>
              <td className="tabular-nums" style={cell('right', t.WHITE)}>{(o.status === 'filled' ? o.filled : o.size).toFixed(4)} {o.coin}</td>
              <td className="tabular-nums" style={cell('right')}>{o.avgPx != null ? fmtUsd(o.avgPx) : '—'}</td>
              <td style={cell('right', statusColor(o))}>{o.status === 'unknown' ? 'UNCONFIRMED' : o.status.toUpperCase()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
