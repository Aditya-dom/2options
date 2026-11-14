import { useMemo, useState } from 'react';
import { healthBps, seriesLabel, type Underlying } from '../lib/contract';
import { fmtFixed, fmtPremium, fmtSize, fmtUsdc, formatUnits, nowNs, NS_PER_MS, parseUnits, SIZE_SCALE } from '../lib/units';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { useWallet } from '../hooks/useWallet';
import { useTheme } from '../theme';
import { fmtDuration } from './FundingPanel';
import type { FundsMode } from './FundsDialog';
import HedgePanel from './HedgePanel';
import { AmountInput, Button, Details, Empty, Kpi, Line, Panel } from './ui';
import { AsciiMeter } from './ascii';

/** LP shares carry 6 implied decimals (the first deposit mints 1 share unit per USDC micro). */
const SHARE_DECIMALS = 6;

export default function VaultPage({ onFunds }: { onFunds: (m: FundsMode) => void }) {
  const { t } = useTheme();
  const { vault, params, series, chain, hedge, lpShares, lpClaim, send } = useProtocol();
  const accountId = useWallet(s => s.accountId);
  const signIn = useWallet(s => s.signIn);
  const now = useNow(1_000);
  const [redeem, setRedeem] = useState('');
  const [busy, setBusy] = useState(false);

  const exposure = useMemo(
    () => series.filter(s => s.netTraderSize !== 0n).map(s => {
      const row = chain.get(s.id);
      const vaultSize = -s.netTraderSize;
      return { s, vaultSize, delta: row ? (row.delta * Number(vaultSize)) / Number(SIZE_SCALE) : null };
    }),
    [series, chain],
  );
  const netDelta = useMemo(() => {
    const out: Partial<Record<Underlying, number>> = {};
    for (const e of exposure) if (e.delta != null) out[e.s.underlying] = (out[e.s.underlying] ?? 0) + e.delta;
    return out;
  }, [exposure]);

  if (!vault || !params) return <Panel title="LP VAULT"><Empty>Loading vault…</Empty></Panel>;

  const equity = vault.equity;
  const sharePrice = equity != null && vault.totalShares > 0n ? (equity * 1_000_000n) / vault.totalShares : null;
  const ratio = healthBps(vault.equity, vault.requirement);
  const myValue = equity != null && vault.totalShares > 0n ? (lpShares * equity) / vault.totalShares : null;
  const redeemUnits = parseUnits(redeem, SHARE_DECIMALS);
  const redeemErr = redeem === '' ? null : redeemUnits == null || redeemUnits === 0n ? 'Enter a share amount.' : redeemUnits > lpShares ? 'More shares than you hold.' : null;
  const redeemValue = redeemUnits != null && equity != null && vault.totalShares > 0n ? (redeemUnits * equity) / vault.totalShares : null;
  const claimReady = lpClaim != null && nowNs() >= lpClaim.unlockNs;

  const doRedeem = async () => {
    if (redeemUnits == null || redeemErr) return;
    setBusy(true);
    if (await send({ kind: 'lp_request_redeem', shares: redeemUnits }, `Redeem ${formatUnits(redeemUnits, SHARE_DECIMALS)} shares`)) setRedeem('');
    setBusy(false);
  };
  const doClaim = async () => {
    setBusy(true);
    await send({ kind: 'lp_claim' }, `Claim ${fmtUsdc(lpClaim!.amount)}`);
    setBusy(false);
  };

  const cap = vault.epochStartCash != null ? (vault.epochStartCash * params.max_epoch_outflow_bps) / 10_000n : null;
  const paid = vault.epochNetOutflow != null && vault.epochNetOutflow > 0n ? vault.epochNetOutflow : 0n;
  const paidPct = cap != null && cap > 0n ? Math.min(100, (Number(paid) / Number(cap)) * 100) : 0;
  const healthColor = ratio == null ? t.GREEN : ratio < params.vault_ratio_bps * 3n / 2n ? t.ORANGE : t.GREEN;
  const label = (text: string) => <div style={{ fontFamily: t.SANS, fontSize: 13, color: t.DIM, marginBottom: 8 }}>{text}</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 16 }}>
        <Panel title="LP VAULT" bodyStyle={{ padding: 18 }} info={<>
          The vault is the counterparty to every trade and earns the spread and hourly funding.{' '}
          {hedge?.enabled
            ? <>The agent hedges its net delta with a perp position off chain (Delta hedge, below); that hedge's profit and loss is <b>not</b> in the equity or share price here.</>
            : <>Its net delta is <b>not hedged</b>: LPs carry that price risk. The agent reports the perp position that would offset it.</>}
        </>}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 18 }}>
            <Kpi label="Vault equity" value={equity != null ? fmtUsdc(equity, 0) : '—'} size={26} sub={equity == null ? 'spot stale' : undefined} />
            <Kpi label="Share price" value={sharePrice != null ? fmtFixed(sharePrice, 6, 6) : '—'} sub="USDC per share" />
            <Kpi label="Health" value={ratio != null ? `${(Number(ratio) / 10_000).toFixed(2)}×` : 'No open risk'} text={ratio == null} color={healthColor}
              sub={`minimum ${(Number(params.vault_ratio_bps) / 10_000).toFixed(2)}×`} />
            {Object.entries(netDelta).map(([u, d]) => (
              <Kpi key={u} label={`Net delta ${u}`} value={`${d! >= 0 ? '+' : ''}${d!.toFixed(2)}`} sub="before hedge" color={Math.abs(d!) > 5 ? t.ORANGE : t.WHITE} />
            ))}
          </div>

          {cap != null && (
            <div style={{ marginTop: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontFamily: t.SANS, fontSize: 13, color: t.DIM, marginBottom: 8 }}>
                <span>Paid to traders this hour</span>
                <span className="tabular-nums" style={{ fontFamily: t.MONO, color: t.GRAY }}>{fmtUsdc(paid, 0)} of {fmtUsdc(cap, 0)}</span>
              </div>
              <AsciiMeter value={paidPct / 100} color={paidPct > 80 ? t.ORANGE : t.GREEN} label="Paid to traders this hour, against the limit" />
            </div>
          )}

          <Details summary="Vault details">
            <Line label="Cash" value={fmtUsdc(vault.cash)} />
            <Line label="Margin requirement" value={vault.requirement != null ? fmtUsdc(vault.requirement) : '—'} />
            <Line label="Insurance fund" value={fmtUsdc(vault.insurance)} />
            <Line label="Pending LP claims" value={fmtUsdc(vault.pendingClaims)} />
            <Line label="Redeem cooldown" value={fmtDuration(Number(params.lp_cooldown_ns / NS_PER_MS))} />
          </Details>
        </Panel>

        <HedgePanel />

        {exposure.length > 0 && (
          <Panel title="VAULT BOOK" bodyStyle={{ padding: '8px 18px 14px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Series', 'Vault position', 'Mark', 'Delta'].map((h, i) => (
                    <th key={h} style={{ fontFamily: t.SANS, fontSize: 12.5, color: t.DIM, fontWeight: 400, padding: '8px 0', textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {exposure.map(({ s, vaultSize, delta }) => (
                  <tr key={s.id} style={{ borderTop: `1px solid ${t.BORDER}` }}>
                    <td style={{ fontFamily: t.MONO, fontSize: 13, color: t.WHITE, padding: '9px 0' }}>{seriesLabel(s)}</td>
                    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 13, padding: '9px 0', textAlign: 'right', color: vaultSize > 0n ? t.GREEN : t.RED }}>
                      {vaultSize > 0n ? '+' : '−'}{fmtSize(vaultSize > 0n ? vaultSize : -vaultSize)}
                    </td>
                    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 13, padding: '9px 0', textAlign: 'right', color: t.GRAY }}>{fmtPremium(s.lastMark)}</td>
                    <td className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 13, padding: '9px 0', textAlign: 'right', color: t.GRAY }}>{delta != null ? (Math.abs(delta) < 0.005 ? '0.00' : delta.toFixed(2)) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
      </div>

      <Panel title="YOUR LP POSITION" bodyStyle={{ padding: 18 }} info="Deposit USDC for shares at the current share price. To leave, request a redemption: your shares burn now at the current price and the USDC unlocks after the cooldown, then claim it. Redemptions that would leave open risk under-collateralized are refused.">
        {!accountId ? (
          <div style={{ display: 'grid', gap: 14 }}>
            <div style={{ fontFamily: t.SANS, fontSize: 15, color: t.GRAY, lineHeight: 1.5 }}>Provide liquidity to the vault and earn the spread and hourly funding on every trade.</div>
            <Button onClick={signIn}>CONNECT WALLET</Button>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 18 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
              <Kpi label="Your shares" value={fmtFixed(lpShares, SHARE_DECIMALS, 2)} size={26} />
              <Kpi label="Value" value={myValue != null ? fmtUsdc(myValue) : '—'} size={26} />
            </div>
            <Button onClick={() => onFunds('lp_deposit')} style={{ padding: '12px 14px' }}>DEPOSIT USDC</Button>

            {lpClaim && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', border: `1px solid ${claimReady ? t.GREEN : t.BORDER}`, background: claimReady ? t.GREEN_BG : 'transparent' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: t.SANS, fontSize: 13, color: t.DIM }}>Pending claim</div>
                  <div className="tabular-nums" style={{ fontFamily: t.MONO, fontSize: 18, color: t.WHITE, marginTop: 2 }}>{fmtUsdc(lpClaim.amount)}</div>
                  <div style={{ fontFamily: t.SANS, fontSize: 12.5, color: claimReady ? t.GREEN : t.ORANGE, marginTop: 2 }}>
                    {claimReady ? 'Ready to claim' : `Unlocks in ${fmtDuration(Number(lpClaim.unlockNs / NS_PER_MS) - now)}`}
                  </div>
                </div>
                <Button variant="buy" onClick={doClaim} disabled={busy || !claimReady}>CLAIM</Button>
              </div>
            )}

            <div style={{ borderTop: `1px solid ${t.BORDER}`, paddingTop: 16, display: 'grid', gap: 10 }}>
              {label('Redeem shares')}
              <AmountInput ariaLabel="Shares to redeem" value={redeem} onChange={setRedeem} suffix="shares"
                onMax={() => setRedeem(formatUnits(lpShares, SHARE_DECIMALS))} />
              {redeemErr ? <div style={{ fontFamily: t.SANS, fontSize: 12.5, color: t.RED }}>{redeemErr}</div>
                : redeemValue != null && <Line label="You receive, at today's price" value={fmtUsdc(redeemValue)} />}
              <Button variant="ghost" onClick={doRedeem} disabled={busy || redeemUnits == null || redeemErr != null}>
                REQUEST REDEMPTION
              </Button>
              <div style={{ fontFamily: t.SANS, fontSize: 12.5, color: t.DIM }}>
                USDC unlocks {fmtDuration(Number(params.lp_cooldown_ns / NS_PER_MS))} after the request.
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
