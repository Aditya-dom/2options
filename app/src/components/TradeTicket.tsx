import { useEffect, useMemo, useState } from 'react';
import type { SignedQuote } from '../backend/types';
import { healthTier, seriesLabel, type Side } from '../lib/contract';
import { friendlyError } from '../lib/errors';
import { previewTrade } from '../lib/preview';
import { DEFAULT_VOL, everlasting } from '../lib/pricing';
import {
  big, fmtPremium, fmtSignedUsdc, fmtSize, fmtUsdc, NS_PER_MS, parseUnits, SIZE_SCALE, SPOT_SCALE, USDC_UNIT,
} from '../lib/units';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { BAD_SIGNATURE, checkQuote } from '../hooks/useAgentTrust';
import { useWallet } from '../hooks/useWallet';
import { agent } from '../services';
import { useTheme } from '../theme';
import { fundingPerHour, type Pick } from './OptionChain';
import PayoffChart from './PayoffChart';
import { AmountInput, Button, Empty, Note, Panel, Row } from './ui';

const MIN_SIZE = 1_000n; // 0.001 contract, the contract's MIN_TRADE_SIZE

export default function TradeTicket({ pick, onPick, size, onSize }: {
  pick: Pick | null;
  onPick: (p: Pick) => void;
  size: string;
  onSize: (s: string) => void;
}) {
  const { t } = useTheme();
  const { series, chain, spots, params, account, paused, send } = useProtocol();
  const accountId = useWallet(s => s.accountId);
  const signIn = useWallet(s => s.signIn);
  const now = useNow(200);
  const [quote, setQuote] = useState<SignedQuote | null>(null);
  const [busy, setBusy] = useState<'quote' | 'submit' | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);

  const seriesMap = useMemo(() => new Map(series.map(s => [s.id, s])), [series]);
  const s = pick ? seriesMap.get(pick.series) : undefined;
  const row = pick ? chain.get(pick.series) : undefined;
  const spot = s ? spots[s.underlying]?.price : undefined;
  const sizeUnits = parseUnits(size, 6);
  const sizeOk = sizeUnits != null && sizeUnits >= MIN_SIZE;

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
      <Panel title="TRADE TICKET">
        <Empty>Pick a bid or ask in the chain to start.</Empty>
      </Panel>
    );
  }

  const side = pick.side;
  const sideColor = side === 'Buy' ? t.GREEN : t.RED;
  const fundPerHour = row && sizeOk ? (fundingPerHour(row) * sizeUnits!) / SIZE_SCALE : null;
  const tier = preview?.ratioAfterBps != null && params ? healthTier(preview.ratioAfterBps, params) : null;
  const blocked = !agent.canTrade
    ? 'No agent is configured, so quotes cannot be signed. Set VITE_AGENT_URL once Gaurav\'s agent is up.'
    : paused ? 'Trading is paused by the operator.'
    : side === 'Sell' && price === 0n ? 'There is no bid for this strike: selling it would earn no premium.'
    : null;

  const getQuote = async () => {
    if (!accountId || !sizeOk) return;
    setBusy('quote');
    setQuoteErr(null);
    try {
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
    <Panel title="TRADE TICKET" right={<span style={{ color: t.WHITE, letterSpacing: 0 }}>{seriesLabel(s)}</span>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
        {(['Buy', 'Sell'] as Side[]).map(x => (
          <Button key={x} variant={x === 'Buy' ? 'buy' : 'sell'} onClick={() => onPick({ series: pick.series, side: x })}
            style={{ opacity: x === side ? 1 : 0.4 }}>
            {x.toUpperCase()}
          </Button>
        ))}
      </div>

      <label style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.14em', color: t.DIM }}>SIZE (CONTRACTS)</label>
      <div style={{ marginTop: 4, marginBottom: 12 }}>
        <AmountInput ariaLabel="Size in contracts" value={size} onChange={onSize} placeholder="1" />
        {size !== '' && !sizeOk && <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.RED, marginTop: 4 }}>Minimum 0.001, up to 6 decimals.</div>}
      </div>

      <Row label={live ? 'Firm price' : 'Indicative price'} value={price != null ? fmtPremium(price) : '—'} color={live ? sideColor : undefined} />
      {preview && <Row label={side === 'Buy' ? 'Premium you pay' : 'Premium you receive'} value={fmtUsdc(preview.cash)} />}
      {fundPerHour != null && (
        <Row label="Funding per hour" value={(side === 'Buy' ? 'pay ' : 'receive ') + fmtPremium(fundPerHour < 0n ? -fundPerHour : fundPerHour)} />
      )}
      {preview && (
        <>
          <Row label="Account margin after" value={fmtUsdc(preview.reqAfter)} />
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

      {payoff.length > 0 && spot != null && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontFamily: t.MONO, fontSize: 9, letterSpacing: '0.14em', color: t.DIM, marginBottom: 4 }}>
            INSTANT P&L VS SPOT (BEFORE FUNDING)
          </div>
          <PayoffChart data={payoff} spot={Number(spot) / Number(SPOT_SCALE)} />
        </div>
      )}
    </Panel>
  );
}
