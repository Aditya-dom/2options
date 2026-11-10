import { useState } from 'react';
import { config, isDemo } from '../lib/config';
import { useAgentTrust } from '../hooks/useAgentTrust';
import { agent, backend } from '../services';
import { useTheme } from '../theme';
import { Dialog, Note, Row } from './ui';

type Level = 'verified' | 'partial' | 'none' | 'bad' | 'demo';

export default function AgentBadge() {
  const { t } = useTheme();
  const s = useAgentTrust();
  const [open, setOpen] = useState(false);

  const level: Level = isDemo ? 'demo'
    : agent.kind !== 'http' ? 'none'
    : s.registered === false || s.lastCheck?.ok === false ? 'bad'
    : s.registered && s.lastCheck?.ok ? 'verified'
    : 'partial';
  const label = { verified: 'AGENT ✓', partial: 'AGENT ?', none: 'NO AGENT', bad: 'AGENT ✗', demo: 'AGENT · DEMO' }[level];
  const color = { verified: t.GREEN, partial: t.ORANGE, none: t.ORANGE, bad: t.RED, demo: t.GRAY }[level];
  const yes = (v: boolean | null | undefined, unknown = 'unknown') => (v == null ? unknown : v ? 'yes' : 'NO');

  return (
    <>
      <button onClick={() => setOpen(true)} title="Who signs the prices" style={{
        fontFamily: t.MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color, background: 'transparent',
        border: `1px solid ${color}`, padding: '3px 7px', borderRadius: 2, cursor: 'pointer', whiteSpace: 'nowrap',
      }}>{label}</button>
      {open && (
        <Dialog title="PRICE AGENT" onClose={() => setOpen(false)} width={460}>
          <div style={{ fontFamily: t.MONO, fontSize: 11, color: t.GRAY, lineHeight: 1.6 }}>
            Every quote is signed by the agent. The contract only accepts signatures from keys it has registered, and this app checks each quote in your browser before you sign.
          </div>
          {isDemo ? (
            <Note tone="warn">Demo mode: prices come from a local model and quotes are unsigned. Nothing here is attested.</Note>
          ) : agent.kind !== 'http' ? (
            <Note tone="warn">No agent is configured (VITE_AGENT_URL), so nothing can be signed or traded.</Note>
          ) : (
            <>
              <Row label="Signing key" value={s.key ? `${s.key.slice(0, 16)}…${s.key.slice(-6)}` : 'not published'} />
              <Row label="Key source" value={s.keySource === 'config' ? 'app config' : s.keySource === 'attestation' ? 'agent /attestation' : '—'} />
              <Row label={`Registered on ${backend.contractId}`} value={yes(s.registered)} color={s.registered ? t.GREEN : s.registered === false ? t.RED : undefined} />
              <Row
                label="Last quote signature"
                value={s.lastCheck ? `${s.lastCheck.ok ? 'valid' : 'INVALID'} · ${s.lastCheck.series} · ${new Date(s.lastCheck.atMs).toLocaleTimeString()}` : 'no quote yet'}
                color={s.lastCheck ? (s.lastCheck.ok ? t.GREEN : t.RED) : undefined}
              />
              <div style={{ borderTop: `1px solid ${t.BORDER}`, paddingTop: 8 }}>
                <Row label="TEE code hash" value={s.attestation?.code_hash ? `${s.attestation.code_hash.slice(0, 18)}…` : 'not attested yet'} />
                {s.attestation?.tee_quote_url && (
                  <Row label="TEE quote" value={<a href={s.attestation.tee_quote_url} target="_blank" rel="noopener noreferrer" style={{ color: t.ACCENT }}>open</a>} />
                )}
                {!s.attestation?.code_hash && (
                  <div style={{ fontFamily: t.MONO, fontSize: 10, color: t.DIM, lineHeight: 1.5, marginTop: 4 }}>
                    The code hash and TEE quote appear here once the agent runs as a Shade Agent (#34).
                  </div>
                )}
              </div>
              {s.registered === false && <Note tone="error">The contract does not accept this key, so trades signed with it will be rejected.</Note>}
              {s.error && <Note tone="error">{s.error}</Note>}
              {!config.agentPublicKey && !s.key && (
                <Note tone="warn">The agent does not publish its key, so quotes cannot be checked here; the contract still checks them.</Note>
              )}
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
