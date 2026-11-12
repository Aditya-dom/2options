import { useState, type CSSProperties } from 'react';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { USDC_UNIT } from '../lib/units';
import { Button } from './ui';

function wait(ms: number): string {
  const mins = Math.max(1, Math.floor(ms / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

/**
 * The test token's faucet: a fixed amount per account per day, enforced by the token contract.
 * Renders nothing on real USDC. With `onlyWhenOpen`, also nothing while the account is cooling down.
 */
export default function FaucetButton({ onlyWhenOpen, style }: { onlyWhenOpen?: boolean; style?: CSSProperties }) {
  const { faucet, send } = useProtocol();
  const now = useNow(30_000);
  const [busy, setBusy] = useState(false);
  if (!faucet) return null;
  const left = faucet.nextClaimMs != null ? faucet.nextClaimMs - now : 0;
  if (onlyWhenOpen && left > 0) return null;
  const amount = (faucet.amount / USDC_UNIT).toLocaleString('en-US');

  const claim = async () => {
    setBusy(true);
    await send({ kind: 'faucet' }, `Faucet: ${amount} test USDC`);
    setBusy(false);
  };

  return (
    <Button variant={left > 0 ? 'ghost' : 'buy'} onClick={claim} disabled={busy || left > 0} style={style}
      title={`The test token pays ${amount} USDC per account every 24 hours.`}>
      {busy ? 'CLAIMING…' : left > 0 ? `FAUCET OPENS IN ${wait(left)}` : `GET ${amount} TEST USDC`}
    </Button>
  );
}
