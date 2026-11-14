import { useEffect, useMemo, useState } from 'react';
import type { SignedQuote } from '../backend/types';
import { healthTier, seriesLabel, type Side } from '../lib/contract';
import { friendlyError } from '../lib/errors';
import { tradeCash } from '../lib/margin';
import { previewTrade } from '../lib/preview';
import { DEFAULT_VOL, everlasting } from '../lib/pricing';
import {
  big, fmtPremium, fmtSignedUsdc, fmtSize, fmtSpot, fmtUsdc, NS_PER_MS, parseUnits, SIZE_SCALE, SPOT_SCALE, USDC_UNIT,
} from '../lib/units';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { BAD_SIGNATURE, checkQuote } from '../hooks/useAgentTrust';
import { useWallet } from '../hooks/useWallet';
import { agent, backend } from '../services';
import { useTheme } from '../theme';
import { fundingPerHour, type Pick } from './OptionChain';
import type { FundsMode } from './FundsDialog';
import FaucetButton from './FaucetButton';
import PayoffChart from './PayoffChart';
import { limitError } from '../lib/limits';
import { useTradeLimits } from '../hooks/useTradeLimits';
import { AmountInput, Button, Empty, Note, Panel, Row } from './ui';

const MIN_SIZE = 1_000n; // 0.001 contract, the contract's MIN_TRADE_SIZE

export default function TradeTicket({ pick, onPick, size, onSize, onFunds }: {
  pick: Pick | null;
  onPick: (p: Pick) => void;
  size: string;
  onSize: (s: string) => void;
  /** Opens the deposit or withdraw dialog. */
  onFunds: (m: FundsMode) => void;
}) {
  const { t } = useTheme();
  const { series, chain, spots, params, account, paused, send } = useProtocol();
  const accountId = useWallet(s => s.accountId);
  const signIn = useWallet(s => s.signIn);
  const now = useNow(200);
  const [quote, setQuote] = useState<SignedQuote | null>(null);
  const [busy, setBusy] = useState<'quote' | 'submit' | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [view, setView] = useState<'Payoff' | 'Greeks'>('Payoff');

  const seriesMap = useMemo(() => new Map(series.map(s => [s.id, s])), [series]);
  const s = pick ? seriesMap.get(pick.series) : undefined;
  const row = pick ? chain.get(pick.series) : undefined;
  const spot = s ? spots[s.underlying]?.price : undefined;
  const sizeUnits = parseUnits(size, 6);
  const limits = useTradeLimits();
  const held = account?.positions.find(p => p.series === pick?.series)?.size ?? 0n;
  const limitMsg = pick && sizeUnits != null ? limitError(limits, pick.side, sizeUnits, held) : null;
  const sizeOk = sizeUnits != null && sizeUnits >= MIN_SIZE && limitMsg == null;

  // Any change to what is being traded invalidates a firm quote.
  useEffect(() => { setQuote(null); setQuoteErr(null); }, [pick?.series, pick?.side, size, accountId]);

  const expiryMs = quote ? Number(big(quote.quote.expiry_ns) / NS_PER_MS) : 0;
  const msLeft = Math.max(0, expiryMs - now);
  const ttlMs = params ? Number(params.max_quote_ttl_ns / NS_PER_MS) : 10_000;
  const live = quote != null && msLeft > 500; // leave time for the transaction to land
  useEffect(() => { if (quote && msLeft === 0) setQuote(null); }, [quote, msLeft]);

  const price = live ? big(quote!.quote.price) : row ? (pick!.side === 'Buy' ? row.ask : row.bid) : null;

  const preview = useMemo(() => {
    if (!pick || !params || price == null || !sizeOk) return null;
    return previewTrade({ account, series: seriesMap, spots, params, trade: { series: pick.series, side: pick.side, size: sizeUnits!, price } });
  }, [pick, params, price, sizeOk, sizeUnits, account, seriesMap, spots]);

  const payoff = useMemo(() => {
    if (!s || spot == null || price == null || !sizeOk) return [];
    const S0 = Number(spot) / Number(SPOT_SCALE);
    const K = Number(s.strike) / Number(SPOT_SCALE);
    const n = Number(sizeUnits) / Number(SIZE_SCALE);
    const sign = pick!.side === 'Buy' ? 1 : -1;
    const paid = Number(price) / Number(USDC_UNIT);
    const vol = DEFAULT_VOL[s.underlying];
    return Array.from({ length: 61 }, (_, i) => {
      const S = S0 * (0.85 + (0.3 * i) / 60);
      return { spot: S, pnl: sign * n * (everlasting(S, K, vol, s.kind).price - paid) };
    });
  }, [s, spot, price, sizeOk, sizeUnits, pick]);

  if (!pick || !s) {
    return (
      <Panel bare title="ORDER">
        <Empty>Click a bid or an ask in the chain.</Empty>
      </Panel>
    );
  }

  const side = pick.side;
  const sideColor = side === 'Buy' ? t.GREEN : t.RED;
  const fundPerHour = row && sizeOk ? (fundingPerHour(row) * sizeUnits!) / SIZE_SCALE : null;
  const cash = price != null && sizeOk ? tradeCash(side, price, sizeUnits!) : null;
  // Spot at which intrinsic value equals the premium (before funding).
  const breakEven = price != null ? (s.kind === 'Call' ? s.strike + price * 100n : s.strike - price * 100n) : null;
  // A put's payoff stops at spot = 0: strike × size, less the premium either way.
  const bound = cash != null ? (s.strike / 100n) * sizeUnits! / SIZE_SCALE - cash : null;
  const sgn = side === 'Buy' ? 1 : -1;
  const contracts = sizeOk ? Number(sizeUnits) / Number(SIZE_SCALE) : 0;
  const tier = preview?.ratioAfterBps != null && params ? healthTier(preview.ratioAfterBps, params) : null;
  const blocked = !agent.canTrade
    ? 'No agent is configured, so quotes cannot be signed. Set VITE_AGENT_URL to a running agent.'
    : paused ? 'Trading is paused by the operator.'
    : side === 'Sell' && price === 0n ? 'There is no bid for this strike: selling it would earn no premium.'
    : null;

  const getQuote = async () => {
    if (!accountId || !sizeOk) return;
    setBusy('quote');
    setQuoteErr(null);
    try {
      // First trade only: add the trading key now, so its wallet confirmation does not eat the quote's timer.
      await backend.prepareTrading?.(accountId);
      const q = await agent.quote({ series: pick.series, side, size: sizeUnits!, taker: accountId });
      if (checkQuote(q)) setQuote(q);
      else setQuoteErr(BAD_SIGNATURE);
    } catch (e) {
      setQuoteErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!quote || !live) return;
    setBusy('submit');
    const ok = await send({ kind: 'trade', quote: quote.quote, signature: quote.signature }, `${side} ${fmtSize(sizeUnits!)} ${s.id}`);
    setBusy(null);
    setQuote(null);
    if (!ok) setQuoteErr('Get a fresh quote to try again.');
  };

  return (
    <Panel bare title="ORDER" bodyStyle={{ padding: 0 }}>
      {/* Pinned, so the side tabs and the funding buttons stay in view while the ticket scrolls. */}
      <div style={{ position: 'sticky', top: 0, zIndex: 2, background: t.BG }}>
      <div role="group" aria-label="Side" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderBottom: `1px solid ${t.BORDER}` }}>
        {(['Buy', 'Sell'] as Side[]).map(x => {
          const on = x === side;
          const c = x === 'Buy' ? t.GREEN : t.RED;
          return (
            <button key={x} aria-pressed={on} onClick={() => onPick({ series: pick.series, side: x })} style={{
              fontFamily: t.MONO, fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', padding: '10px 0', cursor: 'pointer', border: 'none',
              color: on ? c : t.GRAY, background: on ? (x === 'Buy' ? t.GREEN_BG : t.RED_BG) : 'transparent',
              boxShadow: on ? `inset 0 -2px 0 ${c}` : 'none',
            }}>{x} to Open</button>
          );
        })}
      </div>
      {accountId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${t.BORDER}` }}>
          <span style={{ fontFamily: t.MONO, fontSize: 10, color: t.GRAY }}>Collateral</span>
          <span className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 12, fontWeight: 600, color: t.WHITE }}>{fmtUsdc(account?.collateral ?? 0n)}</span>
          <div style={{ flex: 1 }} />
          <Button onClick={() => onFunds('deposit')} style={{ padding: '5px 12px', fontSize: 10 }}>DEPOSIT</Button>
          <Button variant="ghost" onClick={() => onFunds('withdraw')} disabled={!account} style={{ padding: '5px 12px', fontSize: 10 }}>WITHDRAW</Button>
        </div>
      )}
      {accountId && <FaucetStrip />}
      </div>
      <div style={{ padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontFamily: t.MONO, fontSize: 12, fontWeight: 700, color: t.WHITE }}>{seriesLabel(s)}</span>
        <span style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM }}>EVERLASTING</span>
      </div>

      <label style={{ fontFamily: t.MONO, fontSize: 10, color: t.GRAY }}>Size (contracts)</label>
      <div style={{ marginTop: 4, marginBottom: 12 }}>
        <AmountInput ariaLabel="Size in contracts" value={size} onChange={onSize} placeholder="1" />
        {size !== '' && !sizeOk && <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.RED, marginTop: 4 }}>{limitMsg ?? 'Minimum 0.001, up to 6 decimals.'}</div>}
        {limits?.maxTradeSize != null && sizeOk && <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, marginTop: 4 }}>Up to {Number(limits.maxTradeSize) / 1e6} contracts per trade on this deployment.</div>}
      </div>

      <Row label={live ? 'Firm price' : 'Indicative price'} value={price != null ? fmtPremium(price) : '—'} color={live ? sideColor : undefined} />
      {cash != null && <Row label={side === 'Buy' ? 'Max Cost' : 'Premium Received'} value={fmtUsdc(cash)} />}
      {fundPerHour != null && (
        <Row label="Funding per hour" value={(side === 'Buy' ? 'pay ' : 'receive ') + fmtPremium(fundPerHour < 0n ? -fundPerHour : fundPerHour)} />
      )}
      {preview && accountId && (
        <>
          <Row label="Margin Required" value={fmtUsdc(preview.reqAfter)} />
          <Row
            label="Health after"
            value={preview.ratioAfterBps == null ? 'no requirement' : `${(Number(preview.ratioAfterBps) / 10_000).toFixed(2)}×`}
            color={tier === 'healthy' || tier == null ? t.GREEN : tier === 'warning' ? t.ORANGE : t.RED}
          />
          {preview.pendingFunding != null && preview.pendingFunding !== 0n && (
            <Row label="Funding settled first" value={fmtSignedUsdc(-preview.pendingFunding)} />
          )}
        </>
      )}

      <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
        {blocked && <Note tone="warn">{blocked}</Note>}
        {preview?.failure && !blocked && accountId && (
          <Note tone="error">Will be rejected: {friendlyError(preview.failure)}</Note>
        )}
        {quoteErr && <Note tone="error">{quoteErr}</Note>}

        {!accountId ? (
          <Button onClick={signIn}>CONNECT WALLET TO TRADE</Button>
        ) : live ? (
          <>
            <div style={{ height: 3, background: t.BORDER }}>
              <div style={{ height: 3, width: `${Math.min(100, (msLeft / ttlMs) * 100)}%`, background: msLeft < 3_000 ? t.RED : sideColor, transition: 'width 0.2s linear' }} />
            </div>
            <Button variant={side === 'Buy' ? 'buy' : 'sell'} onClick={submit} disabled={busy != null}>
              {busy === 'submit' ? 'SUBMITTING…' : `${side.toUpperCase()} ${fmtSize(sizeUnits!)} @ ${fmtPremium(big(quote!.quote.price))} · ${(msLeft / 1000).toFixed(1)}s`}
            </Button>
          </>
        ) : (
          <Button onClick={getQuote} disabled={busy != null || !sizeOk || !row || blocked != null || preview?.failure != null}>
            {busy === 'quote' ? 'QUOTING…' : 'GET FIRM QUOTE'}
          </Button>
        )}
      </div>

      </div>

      <div role="tablist" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', borderTop: `1px solid ${t.LINE}`, borderBottom: `1px solid ${t.BORDER}` }}>
        {(['Payoff', 'Greeks'] as const).map(x => (
          <button key={x} role="tab" aria-selected={view === x} onClick={() => setView(x)} style={{
            fontFamily: t.MONO, fontSize: 10, letterSpacing: '0.06em', padding: '8px 0', cursor: 'pointer', border: 'none', background: 'transparent',
            color: view === x ? t.WHITE : t.GRAY, boxShadow: view === x ? `inset 0 -2px 0 ${t.ACCENT}` : 'none',
          }}>{x}</button>
        ))}
      </div>
      <div style={{ padding: 12 }}>
        {view === 'Payoff' ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
              {[
                ['Max Loss', side === 'Buy' ? (cash != null ? fmtUsdc(cash) : '—') : s.kind === 'Put' && bound != null ? fmtUsdc(bound) : 'Unlimited', t.RED],
                ['Break Even', breakEven != null ? fmtSpot(breakEven) : '—', t.WHITE],
                ['Max Profit', side === 'Sell' ? (cash != null ? fmtUsdc(cash) : '—') : s.kind === 'Put' && bound != null ? fmtUsdc(bound) : 'Unlimited', t.GREEN],
              ].map(([k, v, c]) => (
                <div key={k}>
                  <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.GRAY }}>{k}</div>
                  <div className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 12, fontWeight: 600, color: c, marginTop: 2 }}>{v}</div>
                </div>
              ))}
            </div>
            {payoff.length > 0 && spot != null && <PayoffChart data={payoff} spot={Number(spot) / Number(SPOT_SCALE)} />}
          </>
        ) : row && sizeOk ? (
          <>
            <Row label="Delta" value={(sgn * row.delta * contracts).toFixed(3)} />
            <Row label="Gamma" value={(sgn * row.gamma * contracts).toFixed(5)} />
            {row.iv != null && <Row label="Implied vol" value={`${(row.iv * 100).toFixed(1)}%`} />}
            <Row label="Funding rate per hour" value={`${(Number(row.fundingRateHourly) / 1e7).toFixed(3)}%`} />
          </>
        ) : <Empty>—</Empty>}
      </div>
    </Panel>
  );
}

/** Shown only while the account can claim, so it disappears for a day after use. */
function FaucetStrip() {
  const { t } = useTheme();
  const { faucet } = useProtocol();
  if (!faucet || (faucet.nextClaimMs != null && faucet.nextClaimMs > Date.now())) return null;
  return (
    <div style={{ padding: '6px 12px', borderBottom: `1px solid ${t.BORDER}` }}>
      <FaucetButton onlyWhenOpen style={{ width: '100%', padding: '6px 12px', fontSize: 10 }} />
    </div>
  );
}
