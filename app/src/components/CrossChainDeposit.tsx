import { Copy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { config, isDemo } from '../lib/config';
import {
  fetchStatus, fetchTokens, isFinal, loadPending, NEAR_USDC_MAINNET, refundAddressError, requestQuote, savePending,
  SOURCES, STATUS_TEXT, type OneClickToken, type PendingSwap, type QuoteResult, type SwapStatus,
} from '../lib/oneclick';
import { big, fmtUsdc, parseUnits } from '../lib/units';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { useWallet } from '../hooks/useWallet';
import { world } from '../services';
import { useTheme } from '../theme';
import { AmountInput, Button, Dialog, Note, Row } from './ui';

/**
 * Deposit from another chain via NEAR Intents 1Click: swap to native USDC delivered to the
 * user's NEAR wallet, then the normal ft_transfer_call deposit.
 *
 * - live:      mainnet twooptions that accepts native USDC; real deposit address and status.
 * - simulated: demo mode; live 1Click quote, delivery simulated into the demo wallet.
 * - preview:   testnet; live quotes only (1Click has no testnet).
 */
const LIVE = !isDemo && config.network === 'mainnet' && config.usdcId === NEAR_USDC_MAINNET;
const MODE: 'live' | 'simulated' | 'preview' = LIVE ? 'live' : isDemo ? 'simulated' : 'preview';
/** Dry quotes need a syntactically valid NEAR recipient; nothing is ever sent to it. */
const PREVIEW_RECIPIENT = '0'.repeat(64);
const POLL_MS = 5_000;
const SIM_STEPS: SwapStatus[] = ['KNOWN_DEPOSIT_TX', 'PROCESSING', 'SUCCESS'];

export default function CrossChainDeposit({ onClose }: { onClose: () => void }) {
  const { t } = useTheme();
  const { usdc, usdcRegistered, send } = useProtocol();
  const accountId = useWallet(s => s.accountId)!;
  const now = useNow(1_000);

  const [tokens, setTokens] = useState<OneClickToken[] | null>(null);
  const [tokensErr, setTokensErr] = useState<string | null>(null);
  const [sourceIdx, setSourceIdx] = useState(0);
  const [amount, setAmount] = useState('');
  const [refundTo, setRefundTo] = useState('');
  const [preview, setPreview] = useState<QuoteResult | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSwap | null>(() => loadPending(accountId));
  const [status, setStatus] = useState<SwapStatus>('PENDING_DEPOSIT');
  const [delivered, setDelivered] = useState<bigint | null>(null);
  const [refundReason, setRefundReason] = useState<string | null>(null);

  useEffect(() => {
    fetchTokens().then(setTokens).catch(e => setTokensErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const options = useMemo(
    () => SOURCES.flatMap(s => {
      const tok = tokens?.find(x => x.blockchain === s.blockchain && x.symbol === s.symbol);
      return tok ? [{ ...s, token: tok }] : [];
    }),
    [tokens],
  );
  const src = options[Math.min(sourceIdx, Math.max(options.length - 1, 0))];
  const units = src ? parseUnits(amount, src.token.decimals) : null;
  const refundErr = src && refundTo ? refundAddressError(src.blockchain, refundTo) : null;
  const slippageBps = src?.symbol === 'USDC' ? 50 : 100;

  // Debounced dry quote for the preview.
  useEffect(() => {
    setPreview(null);
    setQuoteErr(null);
    if (!src || units == null || units === 0n || !refundTo || refundErr) return;
    const timer = setTimeout(() => {
      requestQuote({
        dry: true, originAsset: src.token.assetId, amount: units, refundTo: refundTo.trim(),
        recipient: MODE === 'live' ? accountId : PREVIEW_RECIPIENT, slippageBps,
        deadline: new Date(Date.now() + 3_600_000),
      }).then(setPreview).catch(e => setQuoteErr(e instanceof Error ? e.message : String(e)));
    }, 600);
    return () => clearTimeout(timer);
  }, [src?.token.assetId, units, refundTo, refundErr, accountId, slippageBps]);

  // Track the swap once per pending swap: real status polling, or a scripted run in the demo.
  useEffect(() => {
    if (!pending) return;
    if (pending.deliveredAmount != null) {
      setStatus('SUCCESS');
      setDelivered(big(pending.deliveredAmount));
      return;
    }
    let step = 0;
    let done = false;
    const finish = (s: SwapStatus, amountOut: bigint | null) => {
      done = isFinal(s);
      setStatus(s);
      if (s === 'SUCCESS' && amountOut != null) {
        setDelivered(amountOut);
        // Remember delivery so a reload neither re-credits the demo wallet nor loses the result.
        savePending({ ...pending, deliveredAmount: amountOut.toString() });
      }
    };
    const tick = async () => {
      if (done) return;
      if (pending.simulated) {
        const next = SIM_STEPS[Math.min(step++, SIM_STEPS.length - 1)];
        if (next === 'SUCCESS') world?.creditWallet(pending.account, big(pending.amountOut));
        finish(next, next === 'SUCCESS' ? big(pending.amountOut) : null);
        return;
      }
      try {
        const s = await fetchStatus(pending.depositAddress, pending.depositMemo);
        setRefundReason(s.refundReason);
        finish(s.status, s.status === 'SUCCESS' ? big(s.amountOut ?? pending.amountOut) : null);
      } catch { /* transient; next poll retries */ }
    };
    void tick();
    const timer = setInterval(tick, pending.simulated ? 2_000 : POLL_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const start = async () => {
    if (!src || units == null || !preview) return;
    setBusy(true);
    try {
      let p: PendingSwap;
      if (MODE === 'live') {
        const r = await requestQuote({
          dry: false, originAsset: src.token.assetId, amount: units, refundTo: refundTo.trim(), recipient: accountId,
          slippageBps, deadline: new Date(Date.now() + 3_600_000),
        });
        if (!r.quote.depositAddress) throw new Error('1Click returned no deposit address');
        p = {
          account: accountId, depositAddress: r.quote.depositAddress, depositMemo: r.quote.depositMemo,
          sourceLabel: src.label, amountInFormatted: r.quote.amountInFormatted, amountOut: r.quote.minAmountOut,
          deadline: r.quote.deadline ?? new Date(Date.now() + 3_600_000).toISOString(), createdAt: Date.now(), simulated: false,
        };
      } else {
        p = {
          account: accountId, depositAddress: 'simulated (demo mode)', sourceLabel: src.label,
          amountInFormatted: preview.quote.amountInFormatted, amountOut: preview.quote.amountOut,
          deadline: new Date(Date.now() + 3_600_000).toISOString(), createdAt: Date.now(), simulated: true,
        };
      }
      setStatus('PENDING_DEPOSIT');
      savePending(p);
      setPending(p);
    } catch (e) {
      setQuoteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const depositNow = async () => {
    if (delivered == null) return;
    const amt = usdc != null && usdc < delivered ? usdc : delivered;
    setBusy(true);
    if (await send({ kind: 'deposit', amount: amt }, `Deposit ${fmtUsdc(amt)}`)) {
      savePending(null);
      onClose();
    }
    setBusy(false);
  };

  const reset = () => { savePending(null); setPending(null); setDelivered(null); setStatus('PENDING_DEPOSIT'); };
  const mono = { fontFamily: t.MONO, fontSize: 10, color: t.DIM, lineHeight: 1.5 } as const;

  if (pending) {
    const deadlineMs = Date.parse(pending.deadline);
    return (
      <Dialog title="DEPOSIT FROM ANOTHER CHAIN" onClose={onClose} width={440}>
        {pending.simulated && <Note tone="warn">Demo: no funds move. The quote was live from 1Click; delivery is simulated into your demo wallet.</Note>}
        {status === 'PENDING_DEPOSIT' && !pending.simulated && (
          <>
            <div style={mono}>Send exactly <b style={{ color: t.WHITE }}>{pending.amountInFormatted}</b> ({pending.sourceLabel}) to:</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${t.BORDER}`, background: t.MUTED, padding: '8px 10px' }}>
              <code style={{ flex: 1, fontFamily: t.MONO, fontSize: 12, color: t.WHITE, overflowWrap: 'anywhere' }}>{pending.depositAddress}</code>
              <button aria-label="Copy deposit address" onClick={() => { void navigator.clipboard.writeText(pending.depositAddress); toast.success('Address copied'); }}
                style={{ background: 'transparent', border: 'none', color: t.ACCENT, cursor: 'pointer' }}><Copy size={14} /></button>
            </div>
            {pending.depositMemo && <Row label="Memo (required)" value={pending.depositMemo} color={t.ORANGE} />}
            <Row label="Refund starts" value={deadlineMs > now ? new Date(deadlineMs).toLocaleString() : 'deadline passed'} />
          </>
        )}
        <Row label="Status" value={status.replace(/_/g, ' ')} color={status === 'SUCCESS' ? t.GREEN : status === 'REFUNDED' || status === 'FAILED' ? t.RED : t.ORANGE} />
        <div style={mono}>{STATUS_TEXT[status]}{refundReason ? ` (${refundReason})` : ''}</div>
        <Row label={status === 'SUCCESS' ? 'Delivered' : 'Expected (minimum)'} value={fmtUsdc(delivered ?? big(pending.amountOut))} />
        {status === 'SUCCESS' && (
          <Button onClick={depositNow} disabled={busy}>{busy ? 'CONFIRMING…' : `DEPOSIT ${fmtUsdc(delivered!)} INTO 2Options`}</Button>
        )}
        {isFinal(status) && status !== 'SUCCESS' && <Button variant="ghost" onClick={reset}>START OVER</Button>}
        {!isFinal(status) && <div style={mono}>You can close this window; the swap keeps going and this dialog picks it up again.</div>}
      </Dialog>
    );
  }

  return (
    <Dialog title="DEPOSIT FROM ANOTHER CHAIN" onClose={onClose} width={440}>
      <div style={mono}>Swap from another chain into USDC on NEAR with NEAR Intents (1Click), then deposit it as collateral.</div>
      {MODE === 'preview' && <Note tone="warn">1Click runs on mainnet only and this app is on {config.network}. Quotes below are live, but nothing can be delivered here.</Note>}
      {tokensErr && <Note tone="error">Could not load 1Click tokens: {tokensErr}</Note>}

      <label style={{ ...mono, letterSpacing: '0.14em' }}>FROM</label>
      <select aria-label="Source asset" value={sourceIdx} onChange={e => setSourceIdx(Number(e.target.value))}
        style={{ fontFamily: t.MONO, fontSize: 12, padding: '8px 10px', background: t.MUTED, color: t.WHITE, border: `1px solid ${t.BORDER}` }}>
        {options.length === 0 && <option>{tokens ? 'No supported assets' : 'Loading…'}</option>}
        {options.map((o, i) => <option key={o.token.assetId} value={i}>{o.label}</option>)}
      </select>
      <AmountInput ariaLabel="Amount to send" value={amount} onChange={setAmount} suffix={src?.symbol} />
      {amount !== '' && units == null && <div style={{ ...mono, color: t.RED }}>Up to {src?.token.decimals} decimals.</div>}
      <input aria-label="Refund address" value={refundTo} onChange={e => setRefundTo(e.target.value)}
        placeholder={`Your ${src?.label.split(' · ')[1] ?? ''} address (for refunds)`}
        style={{ fontFamily: t.MONO, fontSize: 12, padding: '9px 10px', background: t.MUTED, color: t.WHITE, border: `1px solid ${t.BORDER}`, outline: 'none' }} />
      {refundErr && <div style={{ ...mono, color: t.RED }}>{refundErr}</div>}

      {preview && (
        <div style={{ borderTop: `1px solid ${t.BORDER}`, paddingTop: 8 }}>
          <Row label="You receive (est.)" value={fmtUsdc(big(preview.quote.amountOut))} color={t.GREEN} />
          <Row label="Minimum after slippage" value={fmtUsdc(big(preview.quote.minAmountOut))} />
          <Row label="Value in" value={`$${Number(preview.quote.amountInUsd).toFixed(2)}`} />
          <Row label="1Click fee" value={`${(preview.appFeeBps / 100).toFixed(2)}%`} />
          <Row label="Time" value={`~${preview.quote.timeEstimate} s after your deposit confirms`} />
        </div>
      )}
      {quoteErr && <Note tone="error">{quoteErr}</Note>}
      {MODE === 'live' && usdcRegistered === false && (
        <Note tone="warn">Your NEAR account is not registered with USDC, so the delivery would fail. Register it from the withdraw dialog first.</Note>
      )}
      <Button onClick={start} disabled={busy || !preview || MODE === 'preview' || (MODE === 'live' && usdcRegistered === false)}>
        {busy ? 'REQUESTING…' : MODE === 'live' ? 'GET DEPOSIT ADDRESS' : MODE === 'simulated' ? 'SIMULATE DEPOSIT' : 'MAINNET ONLY'}
      </Button>
    </Dialog>
  );
}
