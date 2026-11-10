import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtUsd } from '../lib/units';
import { useTheme } from '../theme';

export interface PayoffPoint {
  spot: number;
  pnl: number;
  /** Optional second curve, e.g. P&L after a day of funding. */
  later?: number;
}

/** Adapted from frontend/src/components/PayoffDiagram.tsx. */
export default function PayoffChart({ data, spot, height = 150, laterLabel }: {
  data: PayoffPoint[]; spot: number; height?: number; laterLabel?: string;
}) {
  const { t } = useTheme();
  if (data.length === 0) return null;
  const values = data.flatMap(d => (d.later == null ? [d.pnl] : [d.pnl, d.later]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((max - min) * 0.1, 1);
  const hasLater = laterLabel != null && data.some(d => d.later != null);
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke={t.BORDER} />
          <XAxis
            dataKey="spot" type="number" domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            stroke={t.BORDER} tick={{ fontSize: 10, fill: t.GRAY, fontFamily: t.MONO }}
          />
          <YAxis
            width={68} domain={[min - pad, max + pad]}
            tickFormatter={(v: number) => fmtUsd(v, 0)}
            stroke={t.BORDER} tick={{ fontSize: 10, fill: t.GRAY, fontFamily: t.MONO }}
          />
          <Tooltip
            contentStyle={{ backgroundColor: t.PANEL, border: `1px solid ${t.BORDER}`, borderRadius: 0, fontSize: 11, fontFamily: t.MONO }}
            labelStyle={{ color: t.GRAY }}
            labelFormatter={(v: number) => 'Spot $' + v.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            formatter={(v: number, name: string) => [fmtUsd(v), name]}
          />
          {hasLater && <Legend wrapperStyle={{ fontFamily: t.MONO, fontSize: 10 }} />}
          <ReferenceLine y={0} stroke={t.BORDER2} strokeDasharray="4 4" />
          <ReferenceLine x={spot} stroke={t.ACCENT} strokeDasharray="5 5" />
          <Line name="Now" type="monotone" dataKey="pnl" stroke={t.GREEN} strokeWidth={2} dot={false} isAnimationActive={false} />
          {hasLater && (
            <Line name={laterLabel} type="monotone" dataKey="later" stroke={t.ORANGE} strokeWidth={1.5} strokeDasharray="5 4" dot={false} isAnimationActive={false} />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
