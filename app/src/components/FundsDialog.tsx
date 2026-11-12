import { useMemo, useState } from 'react';
import { maxWithdraw } from '../lib/account';
import { fmtUsdc, formatUnits, parseUnits, USDC_DECIMALS } from '../lib/units';
import { useProtocol } from '../hooks/useProtocol';
import { backend } from '../services';
import { useTheme } from '../theme';
import FaucetButton from './FaucetButton';
import { AmountInput, Button, Dialog, Note, Row } from './ui';

export type FundsMode = 'deposit' | 'withdraw' | 'lp_deposit';

const TITLES: Record<FundsMode, string> = {
  deposit: 'DEPOSIT COLLATERAL',
  withdraw: 'WITHDRAW COLLATERAL',
  lp_deposit: 'DEPOSIT TO LP VAULT',
};

export default function FundsDialog({ mode, onClose }: { mode: FundsMode; onClose: () => void }) {
  const { t } = useTheme();
  const { account, usdc, usdcRegistered, params, series, send } = useProtocol();
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const seriesMap = useMemo(() => new Map(series.map(s => [s.id, s])), [series]);

  const available = mode === 'withdraw'
    ? (account && params ? maxWithdraw(account, seriesMap, params) : 0n)
    : (usdc ?? 0n);
  const units = parseUnits(amount, USDC_DECIMALS);
  const min = params?.min_deposit ?? 1n;
  const error =
    amount === '' ? null
    : units == null ? 'Enter an amount with up to 6 decimals.'
    : units === 0n ? 'Amount must be positive.'
    : mode !== 'withdraw' && units < min ? `Minimum deposit is ${fmtUsdc(min)}.`
    : units > available ? (mode === 'withdraw' ? 'More than you can withdraw right now.' : 'More than your USDC balance.')
    : null;
  const needsRegistration = mode === 'withdraw' && usdcRegistered === false;

  const go = async () => {
    if (units == null || error) return;
    setBusy(true);
    const label = mode === 'deposit' ? `Deposit ${fmtUsdc(units)}` : mode === 'lp_deposit' ? `LP deposit ${fmtUsdc(units)}` : `Withdraw ${fmtUsdc(units)}`;
    const ok = await send(mode === 'withdraw' ? { kind: 'withdraw', amount: units } : { kind: mode, amount: units }, label);
    setBusy(false);
    if (ok) onClose();
  };

  const register = async () => {
    setBusy(true);
    await send({ kind: 'register_usdc' }, 'Register with USDC');
    setBusy(false);
  };

  return (
    <Dialog title={TITLES[mode]} onClose={onClose}>
          <Row label={mode === 'withdraw' ? 'Available to withdraw' : 'USDC in your wallet'} value={fmtUsdc(available)} />
          {mode === 'withdraw' && account && account.positions.length > 0 && (
            <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, lineHeight: 1.5 }}>
              With open positions you can withdraw down to the 1.5× initial margin ratio.
            </div>
          )}
          {mode !== 'withdraw' && available < min && <FaucetButton style={{ width: '100%' }} />}
          <AmountInput ariaLabel="Amount in USDC" value={amount} onChange={setAmount} suffix="USDC"
            onMax={() => setAmount(formatUnits(available, USDC_DECIMALS))} />
          {error && <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.RED }}>{error}</div>}
          {mode === 'lp_deposit' && (
            <Note>LP capital is the counterparty to every trade. It earns spreads and funding, and can be redeemed after a cooldown if the vault's open risk allows.</Note>
          )}
          {mode !== 'withdraw' && backend.mode === 'chain' && (
            <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, lineHeight: 1.5 }}>
              Your wallet will ask you to approve a USDC transfer to {backend.contractId} (attaches 1 yoctoNEAR). If the contract refuses it, the token returns your USDC.
            </div>
          )}
          {needsRegistration ? (
            <>
              <Note tone="warn">Your account is not registered with the USDC token, so a withdrawal would bounce. Register once (a small NEAR storage deposit), then withdraw.</Note>
              <Button onClick={register} disabled={busy}>{busy ? 'REGISTERING…' : 'REGISTER WITH USDC'}</Button>
            </>
          ) : (
            <Button onClick={go} disabled={busy || units == null || error != null}>
              {busy ? 'CONFIRMING…' : mode === 'withdraw' ? 'WITHDRAW' : 'DEPOSIT'}
            </Button>
          )}
    </Dialog>
  );
}
