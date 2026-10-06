"use client";

type ChartPoint = { time: string; value: number };

function pointsForSvg(points: ChartPoint[], width: number, height: number, pad: number) {
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(max * 0.01, 1);
  return points.map((point, index) => {
    const x = pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 2);
    const y = height - pad - ((point.value - min) / range) * (height - pad * 2);
    return { ...point, x, y };
  });
}

export default function MarketChart({ points, ticker, status }: { points: ChartPoint[]; ticker: string; status: string }) {
  if (points.length < 2) {
    return (
      <div className="flex h-64 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.025] text-sm text-slate-500">
        Binance candle data is temporarily unavailable.
      </div>
    );
  }

  const width = 760;
  const height = 270;
  const pad = 22;
  const plotted = pointsForSvg(points, width, height, pad);
  const line = plotted.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${width - pad},${height - pad}`;
  const first = points[0].value;
  const last = points[points.length - 1].value;
  const change = first > 0 ? ((last / first) - 1) * 100 : 0;
  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const positive = change >= 0;

  return (
    <section className="wolv-glass min-w-0 overflow-hidden rounded-2xl p-4 shadow-[0_18px_70px_rgba(0,0,0,.24)] sm:p-5" aria-label={`${ticker} market chart`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-slate-400">
            <span className="wolv-pulse size-2 rounded-full bg-[#d9a80a]" /> Binance market pulse
          </div>
          <div className="mt-1 break-words text-xs leading-5 text-slate-500">1-hour candles · last {points.length} observations · {status}</div>
        </div>
        <div className={`text-right text-sm font-black ${positive ? "text-emerald-400" : "text-rose-400"}`}>
          {positive ? "+" : ""}{change.toFixed(2)}%
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-500">period change</div>
        </div>
      </div>
      <div className="wolv-glass-chart relative overflow-hidden rounded-xl p-2">
        <div className="wolv-scan pointer-events-none absolute inset-y-0 -left-1/4 w-1/4 bg-gradient-to-r from-transparent via-[#d9a80a]/10 to-transparent" />
        <svg viewBox={`0 0 ${width} ${height}`} className="h-48 w-full sm:h-64" role="img" aria-label={`${ticker} price trend from ${min.toFixed(2)} to ${max.toFixed(2)}`}>
          {[0, 1, 2, 3].map((step) => {
            const y = pad + step * ((height - pad * 2) / 3);
            return <line key={step} x1={pad} x2={width - pad} y1={y} y2={y} stroke="rgba(255,255,255,.07)" strokeDasharray="4 8" />;
          })}
          <polygon points={area} fill="url(#wolvArea)" className="wolv-chart-area" />
          <polyline points={line} fill="none" stroke={positive ? "#00ffb2" : "#fb7185"} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="wolv-chart-line" />
          <circle cx={plotted[plotted.length - 1].x} cy={plotted[plotted.length - 1].y} r="5" fill={positive ? "#34d399" : "#fb7185"} className="wolv-pulse" />
          <defs>
            <linearGradient id="wolvArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={positive ? "#00ffb2" : "#fb7185"} stopOpacity=".3" />
              <stop offset="100%" stopColor={positive ? "#00ffb2" : "#fb7185"} stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] uppercase tracking-wider text-slate-500 sm:flex sm:items-center sm:justify-between">
        <span className="min-w-0 truncate">{points[0].time}</span><span>Low ${min.toFixed(2)}</span><span>High ${max.toFixed(2)}</span><span className="min-w-0 truncate text-right sm:text-left">{points[points.length - 1].time}</span>
      </div>
    </section>
  );
}
