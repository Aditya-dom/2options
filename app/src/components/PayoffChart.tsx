import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtUsd } from '../lib/units';
import { useTheme } from '../theme';

/** Adapted from frontend/src/components/PayoffDiagram.tsx. */
export default function PayoffChart({ data, spot, height = 150 }: { data: { spot: number; pnl: number }[]; spot: number; height?: number }) {
  const { t } = useTheme();
  if (data.length === 0) return null;
  const min = Math.min(...data.map(d => d.pnl));
  const max = Math.max(...data.map(d => d.pnl));
  const pad = Math.max((max - min) * 0.1, 1);
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
            formatter={(v: number) => [fmtUsd(v), 'P&L']}
          />
          <ReferenceLine y={0} stroke={t.BORDER2} strokeDasharray="4 4" />
          <ReferenceLine x={spot} stroke={t.ACCENT} strokeDasharray="5 5" />
          <Line type="monotone" dataKey="pnl" stroke={t.GREEN} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
