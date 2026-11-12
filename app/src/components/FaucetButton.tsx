import { useState, type CSSProperties } from 'react';
import { useNow, useProtocol } from '../hooks/useProtocol';
import { USDC_UNIT } from '../lib/units';
import { useTheme } from '../theme';
import { Button } from './ui';

function wait(ms: number): string {
  const mins = Math.max(1, Math.floor(ms / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

/**
 * The test token's faucet: a fixed amount per account per day, enforced by the token contract.
 * Renders nothing on real USDC. With `onlyWhenOpen`, also nothing while the account is cooling down.
 */
export default function FaucetButton({ onlyWhenOpen, badge, style }: { onlyWhenOpen?: boolean; badge?: boolean; style?: CSSProperties }) {
  const { t } = useTheme();
  const { faucet, send } = useProtocol();
  useNow(30_000); // re-render so the countdown moves
  const [busy, setBusy] = useState(false);
  if (!faucet) return null;
  const left = faucet.nextClaimMs != null ? faucet.nextClaimMs - Date.now() : 0;
  if (onlyWhenOpen && left > 0) return null;
  const amount = (faucet.amount / USDC_UNIT).toLocaleString('en-US');

  const claim = async () => {
    setBusy(true);
    await send({ kind: 'faucet' }, `Faucet: ${amount} test USDC`);
    setBusy(false);
  };

  const title = left > 0
    ? `Test USDC faucet: ${amount} USDC per account every 24 hours. Next claim in ${wait(left)}.`
    : `Claim ${amount} test USDC to your wallet (once every 24 hours).`;

  if (badge) {
    const color = left > 0 ? t.DIM : t.GREEN;
    return (
      <button onClick={claim} disabled={busy || left > 0} title={title} style={{
        fontFamily: t.MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color, whiteSpace: 'nowrap',
        background: left > 0 ? 'transparent' : t.GREEN_BG, border: `1px solid ${color}`, padding: '3px 7px', borderRadius: 2,
        cursor: busy || left > 0 ? 'default' : 'pointer', ...style,
      }}>
        {busy ? 'CLAIMING…' : left > 0 ? `FAUCET ${wait(left)}` : `FAUCET · ${amount} USDC`}
      </button>
    );
  }

  return (
    <Button variant={left > 0 ? 'ghost' : 'buy'} onClick={claim} disabled={busy || left > 0} style={style}
      title={title}>
      {busy ? 'CLAIMING…' : left > 0 ? `FAUCET OPENS IN ${wait(left)}` : `GET ${amount} TEST USDC`}
    </Button>
  );
}
