import React, { useMemo, useRef } from 'react';
import { useMountEffect } from '../hooks/useMountEffect';
import { useTheme } from '../theme';

/* Carried over from the earlier Pacifica frontend (gks2022004/nerf@00fe59b, frontend/src/components/ChartPanel.tsx). */

/* ── Symbol → TradingView ticker map ─────────────────────── */
const TV_SYMBOLS: Record<string, string> = {
  BTC:   'BINANCE:BTCUSDT',
  ETH:   'BINANCE:ETHUSDT',
  SOL:   'BINANCE:SOLUSDT',
  BNB:   'BINANCE:BNBUSDT',
  AVAX:  'BINANCE:AVAXUSDT',
  LINK:  'BINANCE:LINKUSDT',
  ARB:   'BINANCE:ARBUSDT',
  DOGE:  'BINANCE:DOGEUSDT',
  MATIC: 'BINANCE:MATICUSDT',
  HYPE:  'KUCOIN:HYPEUSDT',
  NEAR:  'BINANCE:NEARUSDT',
};

interface Props {
  symbol?:    string;
  /* legacy props — kept so App.tsx doesn't need changes */
  history?:   unknown[];
  spot?:      number;
  basePrice?: number;
}

interface TradingViewWidget {
  remove?: () => void;
}

interface TradingViewGlobal {
  widget: new (options: Record<string, unknown>) => TradingViewWidget;
}

declare global {
  interface Window {
    TradingView?: TradingViewGlobal;
  }
}

/* ── Script loader (singleton, loads tv.js once) ─────────── */
const TV_SCRIPT_SRC = 'https://s3.tradingview.com/tv.js';
let tvLoader: Promise<TradingViewGlobal> | null = null;

function loadTradingView(): Promise<TradingViewGlobal> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('TradingView can only be loaded in a browser.'));
  }

  if (window.TradingView) {
    return Promise.resolve(window.TradingView);
  }

  if (!tvLoader) {
    tvLoader = new Promise<TradingViewGlobal>((resolve, reject) => {
      const existingScript = document.querySelector<HTMLScriptElement>(`script[src="${TV_SCRIPT_SRC}"]`);
      const onLoad = () => {
        if (window.TradingView) {
          resolve(window.TradingView);
          return;
        }
        reject(new Error('TradingView script loaded but API is unavailable.'));
      };
      const onError = () => reject(new Error('Failed to load TradingView script.'));

      if (existingScript) {
        existingScript.addEventListener('load', onLoad, { once: true });
        existingScript.addEventListener('error', onError, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = TV_SCRIPT_SRC;
      script.async = true;
      script.onload = onLoad;
      script.onerror = onError;
      document.head.appendChild(script);
    }).catch((error) => {
      tvLoader = null;
      throw error;
    });
  }

  return tvLoader;
}

let uid = 0;

/* ── Rule 5: key-based remount replaces useEffect([tvSymbol]) ── */

/* Inner component: mounts the TradingView widget once (mount effect). */
function ChartWidget({ tvSymbol }: { tvSymbol: string }) {
  const { mode } = useTheme();
  const wrapRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TradingViewWidget | null>(null);
  const containerId = useRef(`tv_chart_${++uid}`);

  /* Rule 4 + 5: mount-once effect — theme/symbol changes trigger
     clean remount via key in the outer ChartPanel component. */
  useMountEffect(() => {
    let disposed = false;

    loadTradingView()
      .then((tradingView) => {
        if (disposed || !wrapRef.current) return;

        const mount = document.createElement('div');
        mount.id = containerId.current;
        mount.style.width = '100%';
        mount.style.height = '100%';
        wrapRef.current.appendChild(mount);

        widgetRef.current = new tradingView.widget({
          autosize: true,
          symbol: tvSymbol,
          interval: '15',
          timezone: 'Etc/UTC',
          theme: mode === 'light' ? 'light' : 'dark',
          style: '1', // candlestick
          locale: 'en',
          toolbar_bg: mode === 'light' ? '#faf8f3' : '#000000',
          enable_publishing: false,
          allow_symbol_change: true,
          hide_side_toolbar: true,
          hide_top_toolbar: false,
          withdateranges: false,
          details: false,
          hotlist: false,
          calendar: false,
          save_image: false,
          hide_legend: false,
          hide_volume: false,
          container_id: containerId.current,
          studies: [],
          overrides: {
            /* Pure black background — TradeStation style */
            'paneProperties.background': '#000000',
            'paneProperties.backgroundType': 'solid',

            /* Subtle grid lines */
            'paneProperties.gridProperties.color': '#111111',
            'paneProperties.vertGridProperties.color': '#111111',
            'paneProperties.horzGridProperties.color': '#111111',

            /* Price scale text */
            'scalesProperties.textColor': '#888888',
            'scalesProperties.backgroundColor': '#000000',
            'scalesProperties.lineColor': '#222222',
            'scalesProperties.fontSize': 10,

            /* Smaller status/legend font */
            'paneProperties.legendProperties.showSeriesTitle': false,
            'paneProperties.legendProperties.showBarChange': false,

            /* Bright green/red candles */
            'mainSeriesProperties.candleStyle.upColor': '#00e676',
            'mainSeriesProperties.candleStyle.downColor': '#ff1744',
            'mainSeriesProperties.candleStyle.borderUpColor': '#00e676',
            'mainSeriesProperties.candleStyle.borderDownColor': '#ff1744',
            'mainSeriesProperties.candleStyle.wickUpColor': '#00e676',
            'mainSeriesProperties.candleStyle.wickDownColor': '#ff1744',

            /* Crosshair */
            'paneProperties.crossHairProperties.color': '#555555',
          },
          studies_overrides: {},
        });
      })
      .catch((error) => {
        console.error('[ChartPanel] TradingView widget failed to load.', error);
      });

    return () => {
      disposed = true;
      const widget = widgetRef.current;
      widgetRef.current = null;
      if (widget?.remove) {
        try { widget.remove(); } catch { /* TradingView can throw during rapid unmount */ }
      }
      wrapRef.current?.replaceChildren();
    };
  });

  return (
    <div style={{ width: '100%', height: '100%', background: mode === 'light' ? '#faf8f3' : '#000000', overflow: 'hidden' }}>
      <div ref={wrapRef} style={{
        width: '111.11%',   /* 1 / 0.9 = 111.11% to fill after scale */
        height: '111.11%',
        transform: 'scale(0.9)',
        transformOrigin: 'top left',
      }} />
    </div>
  );
}

/* Outer component: key forces clean remount when symbol or theme changes (Rule 5) */
const ChartPanel = React.memo(function ChartPanel({ symbol = 'BTC/USD' }: Props) {
  const { mode } = useTheme();
  const tvSymbol = useMemo(() => {
    const base = symbol.split('/')[0]?.trim().toUpperCase() || 'BTC';
    return TV_SYMBOLS[base] ?? `BINANCE:${base}USDT`;
  }, [symbol]);

  return <ChartWidget key={`${tvSymbol}-${mode}`} tvSymbol={tvSymbol} />;
});

export default ChartPanel;
