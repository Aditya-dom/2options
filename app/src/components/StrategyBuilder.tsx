import { Plus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { MAX_BATCH_LEGS } from '../backend/chain';
import type { SignedQuote } from '../backend/types';
import { healthTier, type Side, type Underlying } from '../lib/contract';
import { friendlyError } from '../lib/errors';
import { executionOrder, previewBatch, type TradeLeg } from '../lib/preview';
import { DEFAULT_VOL, everlasting } from '../lib/pricing';
import { buildPreset, PRESETS, type StrategyLeg } from '../lib/strategies';
import { big, fmtPremium, fmtUsdc, NS_PER_MS, parseUnits, SIZE_SCALE, SPOT_SCALE, USDC_UNIT } from '../lib/units';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { BAD_SIGNATURE, checkQuote } from '../hooks/useAgentTrust';
import { useWallet } from '../hooks/useWallet';
import { agent, backend } from '../services';
import { useTheme } from '../theme';
import { fundingPerHour } from './OptionChain';
import PayoffChart from './PayoffChart';
import Select from './Select';
import { Button, Empty, Note, Panel, Row, Stat } from './ui';

const abs = (x: bigint) => (x < 0n ? -x : x);

interface Resolved extends StrategyLeg { idx: number; units: bigint; price: bigint; delta: number; gamma: number; fundPerHour: bigint }

export default function StrategyBuilder() {
  const { t } = useTheme();
  const { series, chain, spots, params, account, paused, send } = useProtocol();
  const accountId = useWallet(s => s.accountId);
  const signIn = useWallet(s => s.signIn);
  const now = useNow(200);
  const underlyings = useMemo(() => [...new Set(series.map(s => s.underlying))], [series]);
  const [u, setU] = useState<Underlying | null>(null);
  const active = u && underlyings.includes(u) ? u : underlyings[0];
  const spot = active ? spots[active]?.price : undefined;
  const [legs, setLegs] = useState<StrategyLeg[]>([]);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [quotes, setQuotes] = useState<SignedQuote[] | null>(null);
  const [busy, setBusy] = useState<'quote' | 'submit' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const seriesMap = useMemo(() => new Map(series.map(s => [s.id, s])), [series]);

  useEffect(() => { setQuotes(null); setErr(null); }, [legs, accountId]);

  // Seed with a straddle once the market is loaded.
  useEffect(() => {
    if (legs.length || !active || spot == null) return;
    const p = PRESETS.find(x => x.id === 'straddle')!;
    const built = buildPreset(p, series, active, spot);
    if (built) { setLegs(built); setPresetId(p.id); }
  }, [active, spot, series, legs.length]);

  const applyPreset = (id: string) => {
    if (!active || spot == null) return;
    const built = buildPreset(PRESETS.find(p => p.id === id)!, series, active, spot);
    if (built) { setLegs(built); setPresetId(id); }
  };
  const edit = (i: number, patch: Partial<StrategyLeg>) => { setLegs(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l))); setPresetId(null); };

  // Resolve legs against the chain; quote prices replace indicative ones once firm.
  const resolved: Resolved[] | null = useMemo(() => {
    const out: Resolved[] = [];
    for (const [idx, l] of legs.entries()) {
      const row = chain.get(l.series);
      const units = parseUnits(l.size, 6);
      if (!row || units == null || units < 1_000n) return null;
      out.push({
        ...l, idx, units, price: l.side === 'Buy' ? row.ask : row.bid,
        delta: row.delta, gamma: row.gamma, fundPerHour: (fundingPerHour(row) * units) / SIZE_SCALE,
      });
    }
    return out;
  }, [legs, chain]);

  const ordered = useMemo(() => (resolved ? executionOrder(resolved) : null), [resolved]);
  const minExpiryMs = quotes ? Math.min(...quotes.map(q => Number(big(q.quote.expiry_ns) / NS_PER_MS))) : 0;
  const msLeft = Math.max(0, minExpiryMs - now);
  const live = quotes != null && msLeft > 1_000;
  useEffect(() => { if (quotes && msLeft === 0) setQuotes(null); }, [quotes, msLeft]);

  const tradeLegs: TradeLeg[] | null = useMemo(() => ordered && ordered.map((l, i) => ({
    series: l.series, side: l.side, size: l.units, price: live ? big(quotes![i].quote.price) : l.price,
  })), [ordered, live, quotes]);
  const preview = useMemo(
    () => (tradeLegs && params ? previewBatch({ account, series: seriesMap, spots, params }, tradeLegs) : null),
    [tradeLegs, params, account, seriesMap, spots],
  );

  const sign = (s: Side) => (s === 'Buy' ? 1 : -1);
  const totals = useMemo(() => {
    if (!resolved || !tradeLegs) return null;
    let premium = 0n, funding = 0n, delta = 0, gamma = 0;
    ordered!.forEach((l, i) => {
      const cash = (tradeLegs[i].price * l.units) / SIZE_SCALE;
      premium += l.side === 'Buy' ? cash : -cash;
      funding += l.side === 'Buy' ? l.fundPerHour : -l.fundPerHour;
      const n = Number(l.units) / Number(SIZE_SCALE);
      delta += sign(l.side) * n * l.delta;
      gamma += sign(l.side) * n * l.gamma;
    });
    return { premium, funding, delta, gamma };
  }, [resolved, ordered, tradeLegs]);

  const payoff = useMemo(() => {
    if (!ordered || !tradeLegs || spot == null || !active || !totals) return [];
    const S0 = Number(spot) / Number(SPOT_SCALE);
    const dayFunding = (Number(totals.funding) / Number(USDC_UNIT)) * 24;
    return Array.from({ length: 81 }, (_, i) => {
      const S = S0 * (0.92 + (0.16 * i) / 80);
      let pnl = 0;
      ordered.forEach((l, j) => {
        const s = seriesMap.get(l.series)!;
        const K = Number(s.strike) / Number(SPOT_SCALE);
        const n = Number(l.units) / Number(SIZE_SCALE);
        pnl += sign(l.side) * n * (everlasting(S, K, DEFAULT_VOL[s.underlying], s.kind).price - Number(tradeLegs[j].price) / Number(USDC_UNIT));
      });
      return { spot: S, pnl, later: pnl - dayFunding };
    });
  }, [ordered, tradeLegs, spot, active, totals, seriesMap]);

  const blocked = !agent.canTrade ? 'No agent is configured, so quotes cannot be signed.'
    : paused ? 'Trading is paused by the operator.'
    : legs.length > MAX_BATCH_LEGS ? `At most ${MAX_BATCH_LEGS} legs per transaction.`
    : ordered?.some(l => l.side === 'Sell' && l.price === 0n) ? 'A short leg has no bid: it would earn no premium.'
    : null;

  const getQuotes = async () => {
    if (!accountId || !ordered) return;
    setBusy('quote');
    setErr(null);
    try {
      // Sequential, in execution order: each trade's nonce must exceed the previous one.
      const qs: SignedQuote[] = [];
      for (const l of ordered) qs.push(await agent.quote({ series: l.series, side: l.side, size: l.units, taker: accountId }));
      if (qs.every(checkQuote)) setQuotes(qs);
      else setErr(BAD_SIGNATURE);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(null);
    }
  };

  const execute = async () => {
    if (!quotes || !live) return;
    setBusy('submit');
    const label = presetId ? PRESETS.find(p => p.id === presetId)!.name : `${quotes.length}-leg strategy`;
    const ok = await send(
      quotes.length === 1
        ? { kind: 'trade', quote: quotes[0].quote, signature: quotes[0].signature }
        : { kind: 'trade_batch', legs: quotes.map(q => ({ quote: q.quote, signature: q.signature })) },
      label,
    );
    setBusy(null);
    setQuotes(null);
    if (!ok) setErr('Nothing was filled: the legs run in one transaction. Get fresh quotes to retry.');
  };

  if (!active || spot == null) return <Panel title="STRATEGY BUILDER"><Empty>Loading market…</Empty></Panel>;

  const tier = preview?.ratioAfterBps != null && params ? healthTier(preview.ratioAfterBps, params) : null;
  const cell = { fontFamily: t.MONO, fontSize: 11, padding: '6px 8px' } as const;
  const options = series.filter(s => s.underlying === active && s.active);
  // A leg is picked as strike + call/put rather than from one long list of every series.
  const strikes = [...new Set(options.map(s => s.strike))].sort((a, b) => (a < b ? -1 : 1));
  const atm = strikes.reduce<bigint | null>((best, k) => (best == null || abs(k - spot) < abs(best - spot) ? k : best), null);
  const strikeOptions = strikes.map(k => ({ value: k.toString(), label: (k / 100_000_000n).toLocaleString('en-US'), hint: k === atm ? 'ATM' : undefined }));
  const seriesFor = (strike: bigint, kind: 'Call' | 'Put') => options.find(s => s.strike === strike && s.kind === kind);

  return (
    <div className="trade-grid">
      <div style={{ display: 'grid', gap: 12, minWidth: 0, alignContent: 'start' }}>
        <Panel title="STRATEGY BUILDER" right={
          underlyings.length > 1 ? (
            <Select ariaLabel="Underlying" value={active} options={underlyings.map(x => ({ value: x, label: x }))}
              onChange={x => { setU(x as Underlying); setLegs([]); }} style={{ fontSize: 10 }} />
          ) : <span style={{ color: t.WHITE, letterSpacing: 0 }}>{active}</span>
        }>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {PRESETS.map(p => {
              const ok = buildPreset(p, series, active, spot) != null;
              return (
                <button key={p.id} disabled={!ok} title={p.blurb} onClick={() => applyPreset(p.id)} style={{
                  fontFamily: t.MONO, fontSize: 10, letterSpacing: '0.04em', padding: '6px 10px', cursor: ok ? 'pointer' : 'not-allowed',
                  color: presetId === p.id ? t.ACCENT : ok ? t.GRAY : t.DIM, background: presetId === p.id ? t.ACCENT_BG : 'transparent',
                  border: `1px solid ${presetId === p.id ? t.ACCENT : t.BORDER}`,
                }}>{p.name}</button>
              );
            })}
          </div>
          {presetId && <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, marginBottom: 10 }}>{PRESETS.find(p => p.id === presetId)!.blurb}</div>}

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
              <thead>
                <tr>{['SIDE', 'SERIES', 'SIZE', 'PRICE', 'Δ', 'FUND/H', ''].map(h => (
                  <th key={h} style={{ ...cell, fontSize: 9, letterSpacing: '0.12em', color: t.DIM, fontWeight: 500, textAlign: h === 'SERIES' || h === 'SIDE' ? 'left' : 'right', borderBottom: `1px solid ${t.BORDER}` }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {legs.map((l, i) => {
                  const row = chain.get(l.series);
                  const sizeUnits = parseUnits(l.size, 6);
                  const sizeOk = sizeUnits != null && sizeUnits >= 1_000n;
                  const price = row ? (l.side === 'Buy' ? row.ask : row.bid) : null;
                  return (
                    <tr key={i} style={{ borderBottom: `1px solid ${t.BORDER}` }}>
                      <td style={cell}>
                        <button onClick={() => edit(i, { side: l.side === 'Buy' ? 'Sell' : 'Buy' })} aria-label={`Toggle side of leg ${i + 1}`} style={{
                          fontFamily: t.MONO, fontSize: 10, fontWeight: 700, width: 48, padding: '3px 0', cursor: 'pointer',
                          color: l.side === 'Buy' ? t.GREEN : t.RED, background: l.side === 'Buy' ? t.GREEN_BG : t.RED_BG, border: `1px solid ${l.side === 'Buy' ? t.GREEN : t.RED}`,
                        }}>{l.side.toUpperCase()}</button>
                      </td>
                      <td style={cell}>
                        {(() => {
                          const s = seriesMap.get(l.series);
                          if (!s) return <span style={{ color: t.DIM }}>{l.series}</span>;
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <Select ariaLabel={`Strike of leg ${i + 1}`} value={s.strike.toString()} options={strikeOptions} style={{ width: 92 }}
                                onChange={k => { const n = seriesFor(BigInt(k), s.kind); if (n) edit(i, { series: n.id }); }} />
                              <div role="group" aria-label={`Call or put for leg ${i + 1}`} style={{ display: 'flex' }}>
                                {(['Call', 'Put'] as const).map(kind => {
                                  const target = seriesFor(s.strike, kind);
                                  const on = s.kind === kind;
                                  return (
                                    <button key={kind} aria-pressed={on} disabled={!target} title={kind}
                                      onClick={() => target && !on && edit(i, { series: target.id })}
                                      style={{
                                        fontFamily: t.MONO, fontSize: 10, fontWeight: 700, width: 26, padding: '4px 0', cursor: target ? 'pointer' : 'not-allowed',
                                        color: on ? t.ACCENT : t.GRAY, background: on ? t.ACCENT_BG : 'transparent',
                                        border: `1px solid ${on ? t.ACCENT : t.BORDER}`, marginLeft: kind === 'Put' ? -1 : 0,
                                      }}>{kind === 'Call' ? 'C' : 'P'}</button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })()}
                      </td>
                      <td style={{ ...cell, textAlign: 'right' }}>
                        <input aria-label={`Size of leg ${i + 1}`} inputMode="decimal" value={l.size} onChange={e => edit(i, { size: e.target.value.replace(/[^\d.]/g, '') })}
                          style={{ width: 64, textAlign: 'right', fontFamily: t.MONO, fontSize: 11, background: t.MUTED, color: t.WHITE, border: `1px solid ${sizeOk ? t.BORDER : t.RED}`, padding: '3px 6px' }} />
                      </td>
                      <td className="tabular-nums" style={{ ...cell, textAlign: 'right', color: l.side === 'Buy' ? t.GREEN : t.RED }}>{price != null ? fmtPremium(price) : '—'}</td>
                      <td className="tabular-nums" style={{ ...cell, textAlign: 'right', color: t.GRAY }}>{row ? (sign(l.side) * row.delta).toFixed(3) : '—'}</td>
                      <td className="tabular-nums" style={{ ...cell, textAlign: 'right', color: l.side === 'Buy' ? t.RED : t.GREEN }}>
                        {row && sizeOk ? (l.side === 'Buy' ? '-' : '+') + fmtPremium((fundingPerHour(row) * sizeUnits!) / SIZE_SCALE) : '—'}
                      </td>
                      <td style={{ ...cell, textAlign: 'right' }}>
                        <button aria-label={`Remove leg ${i + 1}`} onClick={() => { setLegs(ls => ls.filter((_, j) => j !== i)); setPresetId(null); }}
                          style={{ background: 'transparent', border: 'none', color: t.DIM, cursor: 'pointer' }}><X size={13} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button onClick={() => { const s = options[Math.floor(options.length / 2)]; if (s) { setLegs(ls => [...ls, { series: s.id, side: 'Buy', size: '1' }]); setPresetId(null); } }}
            disabled={legs.length >= MAX_BATCH_LEGS}
            style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 6, fontFamily: t.MONO, fontSize: 10, color: legs.length >= MAX_BATCH_LEGS ? t.DIM : t.ACCENT, background: 'transparent', border: `1px dashed ${t.BORDER}`, padding: '6px 10px', cursor: 'pointer' }}>
            <Plus size={12} /> ADD LEG
          </button>
        </Panel>

        <Panel title="P&L VS SPOT">
          {payoff.length ? (
            <PayoffChart data={payoff} spot={Number(spot) / Number(SPOT_SCALE)} height={260} laterLabel="After 24h of funding" />
          ) : <Empty>Add legs with valid sizes to see the payoff.</Empty>}
          <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, marginTop: 6, lineHeight: 1.5 }}>
            Instant P&L at today's prices if spot moved now, and after a day of funding at today's rates. Everlasting options never expire: funding is the cost of holding them.
          </div>
        </Panel>
      </div>

      <div style={{ display: 'grid', gap: 12, minWidth: 0, alignContent: 'start' }}>
        <Panel title="PACKAGE">
          {totals ? (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Stat label={totals.premium >= 0n ? 'Net debit' : 'Net credit'} value={fmtUsdc(totals.premium >= 0n ? totals.premium : -totals.premium)} color={totals.premium >= 0n ? t.WHITE : t.GREEN} />
              <Stat label={totals.funding >= 0n ? 'Funding you pay /h' : 'Funding you earn /h'} value={fmtPremium(totals.funding >= 0n ? totals.funding : -totals.funding)} color={totals.funding >= 0n ? t.ORANGE : t.GREEN} />
              <Stat label="Net delta" value={totals.delta.toFixed(3)} />
              <Stat label="Net gamma" value={totals.gamma.toFixed(4)} />
            </div>
          ) : <Empty>Fix the highlighted legs.</Empty>}
          {preview && (
            <>
              <Row label="Account margin after" value={fmtUsdc(preview.reqAfter)} />
              <Row label="Health after" value={preview.ratioAfterBps == null ? 'no requirement' : `${(Number(preview.ratioAfterBps) / 10_000).toFixed(2)}×`}
                color={tier === 'healthy' || tier == null ? t.GREEN : tier === 'warning' ? t.ORANGE : t.RED} />
            </>
          )}
          {ordered && ordered.length > 1 && (
            <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, lineHeight: 1.5, marginTop: 8 }}>
              Executes as one transaction, buys first: every leg fills or none does.
              {backend.mode === 'chain' && ' Your wallet asks for one confirmation (limited keys sign single trades only).'}
            </div>
          )}
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            {blocked && <Note tone="warn">{blocked}</Note>}
            {preview?.failure && !blocked && accountId && (
              <Note tone="error">
                Will be rejected{preview.failedLeg != null && ordered && ordered.length > 1 ? ` at leg ${preview.failedLeg + 1} (${ordered[preview.failedLeg].side} ${ordered[preview.failedLeg].series})` : ''}: {friendlyError(preview.failure)}
              </Note>
            )}
            {err && <Note tone="error">{err}</Note>}
            {!accountId ? <Button onClick={signIn}>CONNECT WALLET</Button> : live ? (
              <>
                <div style={{ height: 3, background: t.BORDER }}>
                  <div style={{ height: 3, width: `${Math.min(100, (msLeft / Number((params?.max_quote_ttl_ns ?? 10_000_000_000n) / NS_PER_MS)) * 100)}%`, background: msLeft < 3_000 ? t.RED : t.ACCENT, transition: 'width 0.2s linear' }} />
                </div>
                <Button onClick={execute} disabled={busy != null}>
                  {busy === 'submit' ? 'SUBMITTING…' : `EXECUTE ${quotes!.length} LEG${quotes!.length > 1 ? 'S' : ''} · ${(msLeft / 1000).toFixed(1)}s`}
                </Button>
              </>
            ) : (
              <Button onClick={getQuotes} disabled={busy != null || !ordered || blocked != null || preview?.failure != null}>
                {busy === 'quote' ? 'QUOTING…' : 'GET FIRM QUOTES'}
              </Button>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}
