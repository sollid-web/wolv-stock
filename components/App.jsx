'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAccount } from 'wagmi';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleDot,
  Clock3,
  Database,
  Filter,
  Gauge,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Wallet,
  X,
  Zap,
} from 'lucide-react';
import TradeButton from '@/components/TradeButton';
import { usdtAmountToWei } from '@/lib/apiValidation';
import { normalizePerSharePrice } from '@/lib/opportunityMath';

const TIMEFRAMES = ['1H', '1D', '1W', '1M', 'ALL'];
const QUOTE_AMOUNT_USDT = '10';
const QUOTE_AMOUNT_RAW = usdtAmountToWei(QUOTE_AMOUNT_USDT);
const MARKET_SYNC_INTERVAL_MS = 60_000;
const QUOTE_SYNC_INTERVAL_MS = 25_000;
const REFRESH_QUOTE_TTL_MS = 30_000;
const NAV_ITEMS = [
  { id: 'terminal', label: 'Terminal', icon: Activity },
  { id: 'markets', label: 'Markets Directory', icon: Layers3 },
  { id: 'lens', label: 'AI Live Lens', icon: Sparkles },
];

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unitsToNumber(value, decimals) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const places = Number(decimals);
  if (!Number.isInteger(places) || places < 0 || places > 36) return null;
  try {
    const raw = BigInt(value);
    const scale = 10n ** BigInt(places);
    const whole = raw / scale;
    const fraction = (raw % scale).toString().padStart(places, '0').slice(0, 10);
    const parsed = Number(places === 0 || !fraction ? whole.toString() : `${whole}.${fraction}`);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function money(value, digits = 2) {
  const parsed = numberOrNull(value);
  if (parsed == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(parsed);
}

function compactMoney(value) {
  const parsed = numberOrNull(value);
  if (parsed == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(parsed);
}

function statusLabel(asset) {
  const status = String(asset?.marketStatus || '').trim();
  if (status) return status.replaceAll('_', ' ').toUpperCase();
  if (asset?.openState === true) return 'OPEN';
  if (asset?.openState === false) return 'CLOSED';
  return 'STATUS UNAVAILABLE';
}

function statusTone(asset) {
  if (asset?.openState === true || /regular|trading|open/i.test(asset?.marketStatus || '')) return 'open';
  if (asset?.openState === false || /closed|pause|halt/i.test(asset?.marketStatus || '')) return 'warn';
  return 'muted';
}

function formatTime(timestamp, timeframe) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '—';
  if (timeframe === '1H' || timeframe === '1D') {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function normalizeAsset(raw) {
  return {
    ...raw,
    address: raw?.address || raw?.tokenContractAddress || '',
    ticker: raw?.ticker || raw?.underlyingTicker || raw?.symbol || 'ASSET',
    name: raw?.name || raw?.underlyingName || raw?.tokenName || 'Tokenized asset',
    platform: raw?.platform || raw?.platformId || 'unknown',
    tokenPrice: numberOrNull(raw?.tokenPrice),
    referencePrice: numberOrNull(raw?.referencePrice),
    tokenToShareRatio: numberOrNull(raw?.tokenToShareRatio),
    decimals: numberOrNull(raw?.decimals),
    volume24H: numberOrNull(raw?.volume24H),
    marketCap: numberOrNull(raw?.marketCap),
    marketStatus: raw?.marketStatus || raw?.statusInfo?.marketStatus || null,
    openState: typeof raw?.openState === 'boolean' ? raw.openState : raw?.statusInfo?.openState ?? null,
  };
}

function initialTickerAddress(assets) {
  const preferred = assets.find((asset) => /^SPY$/i.test(asset.ticker));
  return preferred?.address || assets[0]?.address || '';
}

function routeSummary(route, asset) {
  const amountIn = unitsToNumber(route?.fromTokenAmount, route?.fromToken?.decimal);
  const amountOut = unitsToNumber(route?.toTokenAmount, route?.toToken?.decimal);
  const inputUnitPrice = numberOrNull(route?.fromToken?.tokenUnitPrice) ?? 1;
  const tokenPrice = amountIn != null && amountOut != null && amountOut > 0
    ? (amountIn * inputUnitPrice) / amountOut
    : null;
  const ratio = numberOrNull(asset?.tokenToShareRatio);
  const sharePrice = tokenPrice != null && ratio != null && ratio > 0 ? tokenPrice / ratio : null;
  const reference = normalizePerSharePrice(asset?.referencePrice, ratio);
  const gap = sharePrice != null && reference != null && reference > 0
    ? ((sharePrice / reference) - 1) * 100
    : null;
  return {
    raw: route,
    vendor: route?.vendorName || route?.vendor || 'Aggregator route',
    mode: route?.executionMode || 'RFQ',
    tokenPrice,
    sharePrice,
    gap,
    impact: numberOrNull(route?.priceImpactPercent),
    outputAmount: amountOut,
  };
}

function GlassPanel({ children, className = '', as: Element = 'section', ...props }) {
  return (
    <Element className={`glass-panel relative min-w-0 overflow-hidden rounded-2xl p-5 sm:p-6 ${className}`} {...props}>
      <div className="glass-specular" aria-hidden="true" />
      {children}
    </Element>
  );
}

function Badge({ children, tone = 'cyan', pulse = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.12em] ${
      tone === 'green'
        ? 'border-[#00FFB2]/25 bg-[#00FFB2]/[0.08] text-[#00FFB2]'
        : tone === 'gold'
          ? 'border-[#FFC700]/30 bg-[#FFC700]/[0.08] text-[#FFC700]'
          : tone === 'red'
            ? 'border-rose-400/25 bg-rose-400/[0.08] text-rose-300'
            : 'border-[#00B7FF]/25 bg-[#00B7FF]/[0.08] text-[#61D3FF]'
    } ${className}`}>
      {pulse && <span className={`live-dot ${tone === 'gold' ? 'bg-[#FFC700]' : tone === 'red' ? 'bg-rose-300' : 'bg-[#00FFB2]'}`} />}
      {children}
    </span>
  );
}

function StatBlock({ label, value, note, icon: Icon = Activity, accent = 'cyan' }) {
  const accentClass = accent === 'green' ? 'text-[#00FFB2]' : accent === 'gold' ? 'text-[#FFC700]' : 'text-[#00B7FF]';
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-500">{label}</span>
        <Icon className={`size-4 ${accentClass}`} aria-hidden="true" />
      </div>
      <div className="break-words text-xl font-black tracking-tight text-white sm:text-2xl">{value}</div>
      {note && <div className="mt-1 text-[11px] leading-relaxed text-slate-500">{note}</div>}
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const price = payload.find((item) => item.dataKey === 'value')?.value;
  const volume = payload.find((item) => item.dataKey === 'volume')?.value;
  return (
    <div className="rounded-xl border border-white/10 bg-[#090d13]/95 px-3 py-2 text-xs shadow-2xl backdrop-blur-xl">
      <div className="text-slate-500">{label}</div>
      <div className="mt-1 font-bold text-white">{money(price, 4)}</div>
      {numberOrNull(volume) != null && <div className="mt-1 text-slate-500">Volume {Number(volume).toLocaleString()}</div>}
    </div>
  );
}

function TickerTape({ assets, onSelect }) {
  if (!assets.length) return null;
  const ticker = (asset, index, disabled = false) => (
    <span key={`${asset.address}-${index}`} className="inline-flex shrink-0 items-center gap-3 pr-7">
      {disabled ? (
        <span className="font-bold text-white/90">{asset.ticker}</span>
      ) : (
        <button type="button" onClick={() => onSelect(asset.address)} className="font-bold text-white/90 transition hover:text-[#00FFB2]">{asset.ticker}</button>
      )}
      <span className="font-mono text-white/55">{money(asset.tokenPrice)}</span>
      {asset.marketStatus && <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-slate-500">{asset.marketStatus}</span>}
      <span className="text-white/15">/</span>
    </span>
  );
  return (
    <div className="wolv-ticker-viewport border-b border-white/[0.06] bg-black/35" aria-label="Featured market snapshots">
      <div className="wolv-ticker-track flex w-max items-center py-2.5 font-mono text-[11px]">
        <div className="flex items-center">{assets.map((asset, index) => ticker(asset, index))}</div>
        <div aria-hidden="true" className="flex items-center">{assets.map((asset, index) => ticker(asset, index, true))}</div>
      </div>
    </div>
  );
}

function MarketChart({ candles, ticker, timeframe, mounted, loading, error }) {
  const points = candles || [];
  const min = points.length ? Math.min(...points.map((point) => point.value)) : null;
  const max = points.length ? Math.max(...points.map((point) => point.value)) : null;
  const change = points.length > 1 && points[0].value > 0
    ? ((points[points.length - 1].value / points[0].value) - 1) * 100
    : null;
  return (
    <GlassPanel className="chart-panel p-4 sm:p-6" aria-label={`${ticker} verified price chart`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
            <span className="size-2 rounded-full bg-[#FFC700] shadow-[0_0_12px_rgba(255,199,0,.6)]" /> Binance market pulse
          </div>
          <div className="mt-1 text-[11px] text-slate-500">{timeframe} candles · on-chain token price · BNB Smart Chain</div>
        </div>
        {change != null && (
          <div className={`text-right text-sm font-black ${change >= 0 ? 'text-[#00FFB2]' : 'text-rose-300'}`}>
            {change >= 0 ? '+' : ''}{change.toFixed(3)}%
            <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-500">period change</div>
          </div>
        )}
      </div>
      <div className="chart-stage h-[250px] min-w-0 sm:h-[335px]">
        {loading && points.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-slate-500"><LoaderCircle className="size-4 animate-spin" /> Loading verified candles…</div>
        ) : error && points.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-xs text-slate-500"><AlertTriangle className="size-5 text-[#FFC700]" />{error}</div>
        ) : points.length < 2 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center text-xs text-slate-500"><BarChart3 className="size-5 text-slate-600" />No verified candle history is available for this asset and interval.</div>
        ) : mounted ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="wolvPriceArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FFC700" stopOpacity={0.22} />
                  <stop offset="96%" stopColor="#FFC700" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(255,255,255,.055)" vertical={false} strokeDasharray="4 7" />
              <XAxis dataKey="time" tick={{ fill: '#667085', fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis yAxisId="price" domain={['auto', 'auto']} tick={{ fill: '#667085', fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value) => Number(value).toFixed(2)} width={52} />
              <YAxis yAxisId="volume" orientation="right" hide domain={[0, 'dataMax * 4']} />
              <Tooltip content={<ChartTooltip />} />
              <Area yAxisId="price" type="monotone" dataKey="value" stroke="none" fill="url(#wolvPriceArea)" isAnimationActive={false} />
              <Line yAxisId="price" type="monotone" dataKey="value" stroke="#FFC700" strokeWidth={2.7} dot={false} activeDot={{ r: 4, fill: '#00FFB2', stroke: '#06110f', strokeWidth: 2 }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">Preparing chart…</div>
        )}
      </div>
      {points.length > 1 && (
        <div className="mt-3 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wider text-slate-500">
          <span>{points[0].time}</span><span>Low {money(min, 3)}</span><span>High {money(max, 3)}</span><span>{points[points.length - 1].time}</span>
        </div>
      )}
    </GlassPanel>
  );
}

function EmptyData({ title, body, action }) {
  return (
    <div className="flex min-h-[180px] flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-5 py-8 text-center">
      <Database className="mb-3 size-6 text-slate-600" />
      <div className="text-sm font-bold text-slate-300">{title}</div>
      <div className="mt-1 max-w-md text-xs leading-relaxed text-slate-500">{body}</div>
      {action}
    </div>
  );
}

/** @param {{ assets?: Record<string, unknown>[], feedError?: string | null }} props */
export default function App({ assets: rawAssets = [], feedError = null }) {
  const { address, isConnected, chainId } = useAccount();
  const assets = useMemo(() => (Array.isArray(rawAssets) ? rawAssets.map(normalizeAsset).filter((asset) => asset.address) : []), [rawAssets]);
  const [selectedAddress, setSelectedAddress] = useState(() => initialTickerAddress(assets));
  const [activeTab, setActiveTab] = useState('terminal');
  const [timeframe, setTimeframe] = useState('1D');
  const [liveSync, setLiveSync] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRoute, setDrawerRoute] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [platformFilter, setPlatformFilter] = useState('all');
  const [sessionFilter, setSessionFilter] = useState('all');
  const [sortMode, setSortMode] = useState('ticker');
  const [marketResult, setMarketResult] = useState({ address: '', timeframe: '', loading: false, candles: [], error: null, updatedAt: null, snapshot: null });
  const [quoteResult, setQuoteResult] = useState({ address: '', loading: false, routes: [], error: null, fetchedAt: null });
  const [analysis, setAnalysis] = useState({ loading: false, data: null, error: null });
  const [analysisNonce, setAnalysisNonce] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [copiedAddress, setCopiedAddress] = useState('');
  const [mounted, setMounted] = useState(false);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.address.toLowerCase() === selectedAddress.toLowerCase()) || assets[0] || null,
    [assets, selectedAddress],
  );
  const currentAsset = useMemo(() => {
    if (!selectedAsset) return null;
    const snapshot = marketResult.address.toLowerCase() === selectedAsset.address.toLowerCase() ? marketResult.snapshot : null;
    return snapshot ? { ...selectedAsset, ...snapshot } : selectedAsset;
  }, [marketResult.address, marketResult.snapshot, selectedAsset]);
  const featuredAssets = useMemo(() => {
    const preferredTickers = ['SPY', 'SPCX', 'NVDA'];
    const preferred = preferredTickers
      .map((ticker) => assets.find((asset) => asset.ticker.toUpperCase() === ticker || asset.ticker.toUpperCase().startsWith(`${ticker}ON`)))
      .filter(Boolean);
    const combined = [...preferred, ...assets];
    const unique = [];
    const addresses = new Set();
    for (const asset of combined) {
      const key = asset.address.toLowerCase();
      if (!addresses.has(key)) {
        addresses.add(key);
        unique.push(asset);
      }
      if (unique.length === 6) break;
    }
    return unique;
  }, [assets]);

  const chartCandles = useMemo(() => (
    marketResult.address.toLowerCase() === selectedAsset?.address.toLowerCase()
      && marketResult.timeframe === timeframe ? marketResult.candles : []
  ), [marketResult.address, marketResult.candles, marketResult.timeframe, selectedAsset?.address, timeframe]);
  const quoteAgeSeconds = quoteResult.fetchedAt ? Math.max(0, Math.floor((clock - quoteResult.fetchedAt) / 1000)) : null;
  const quoteIsFresh = quoteAgeSeconds != null && quoteAgeSeconds < REFRESH_QUOTE_TTL_MS / 1000;
  const routeRows = useMemo(() => {
    if (!currentAsset || quoteResult.address.toLowerCase() !== currentAsset.address.toLowerCase()) return [];
    return (quoteResult.routes || [])
      .map((route) => routeSummary(route, currentAsset))
      .filter((route) => Number.isFinite(route.outputAmount) && route.outputAmount > 0);
  }, [currentAsset, quoteResult.address, quoteResult.routes]);
  const referencePrice = normalizePerSharePrice(currentAsset?.referencePrice, currentAsset?.tokenToShareRatio);
  const listedPrice = numberOrNull(currentAsset?.tokenPrice);
  const shareRatio = numberOrNull(currentAsset?.tokenToShareRatio);
  const listedPerShare = listedPrice != null && shareRatio != null && shareRatio > 0 ? listedPrice / shareRatio : null;
  const bestRoute = routeRows[0] || null;
  const spreadPercent = routeRows.length > 1 && routeRows.every((route) => route.sharePrice != null)
    ? ((Math.max(...routeRows.map((route) => route.sharePrice)) / Math.min(...routeRows.map((route) => route.sharePrice))) - 1) * 100
    : null;

  const marketPlatforms = useMemo(() => ['all', ...new Set(assets.map((asset) => asset.platform.toLowerCase()).filter(Boolean).sort())], [assets]);
  const filteredAssets = useMemo(() => {
    const search = searchTerm.trim().toLowerCase();
    const result = assets.filter((asset) => {
      const matchesSearch = !search || [asset.ticker, asset.name, asset.platform, asset.address, asset.symbol]
        .some((value) => String(value || '').toLowerCase().includes(search));
      const matchesPlatform = platformFilter === 'all' || asset.platform.toLowerCase() === platformFilter;
      const known = asset.openState != null || Boolean(asset.marketStatus);
      const matchesSession = sessionFilter === 'all'
        || (sessionFilter === 'open' && (asset.openState === true || /regular|trading|open/i.test(asset.marketStatus || '')))
        || (sessionFilter === 'closed' && (asset.openState === false || /closed|pause|halt/i.test(asset.marketStatus || '')))
        || (sessionFilter === 'unknown' && !known);
      return matchesSearch && matchesPlatform && matchesSession;
    });
    return result.sort((a, b) => {
      if (sortMode === 'marketCap') return (b.marketCap || 0) - (a.marketCap || 0);
      if (sortMode === 'price') return (b.tokenPrice || 0) - (a.tokenPrice || 0);
      return a.ticker.localeCompare(b.ticker);
    });
  }, [assets, platformFilter, searchTerm, sessionFilter, sortMode]);

  const realizedVolatility = useMemo(() => {
    if (chartCandles.length < 3) return null;
    const returns = [];
    for (let index = 1; index < chartCandles.length; index += 1) {
      const previous = chartCandles[index - 1].value;
      const current = chartCandles[index].value;
      if (previous > 0 && current > 0) returns.push(Math.log(current / previous));
    }
    if (returns.length < 2) return null;
    const average = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + ((value - average) ** 2), 0) / returns.length;
    return Math.sqrt(variance) * 100;
  }, [chartCandles]);

  const sessionCounts = useMemo(() => {
    const counts = { open: 0, closed: 0, unknown: 0, paused: 0 };
    for (const asset of assets) {
      const label = (asset.marketStatus || '').toLowerCase();
      if (label.includes('pause') || label.includes('halt')) counts.paused += 1;
      else if (asset.openState === true || /regular|trading|open/.test(label)) counts.open += 1;
      else if (asset.openState === false || /closed|postmarket/.test(label)) counts.closed += 1;
      else counts.unknown += 1;
    }
    return counts;
  }, [assets]);

  const selectAsset = useCallback((addressToSelect) => {
    setSelectedAddress(addressToSelect);
    setActiveTab('terminal');
  }, []);

  const refreshMarket = useCallback(async (signal) => {
    if (!selectedAsset?.address) return;
    const params = new URLSearchParams({ address: selectedAsset.address, timeframe });
    try {
      const response = await fetch(`/api/terminal/market?${params}`, { cache: 'no-store', signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || 'Market data is unavailable');
      const candles = Array.isArray(payload.candles) ? payload.candles.map((point) => ({
        ...point,
        time: formatTime(point.timestamp, timeframe),
      })) : [];
      setMarketResult({
        address: selectedAsset.address,
        timeframe,
        loading: false,
        candles,
        error: payload.candleError || null,
        updatedAt: numberOrNull(payload.fetchedAt) || Date.now(),
        snapshot: payload.snapshot || null,
      });
    } catch (error) {
      if (signal?.aborted) return;
      setMarketResult((previous) => ({
        ...previous,
        address: selectedAsset.address,
        timeframe,
        loading: false,
        error: error instanceof Error ? error.message : 'Market data is unavailable',
      }));
    }
  }, [selectedAsset?.address, timeframe]);

  const refreshQuote = useCallback(async (signal) => {
    if (!selectedAsset?.address || !address || !isConnected || chainId !== 56) return;
    const params = new URLSearchParams({
      toToken: selectedAsset.address,
      amount: QUOTE_AMOUNT_RAW,
      userWalletAddress: address,
    });
    setQuoteResult((previous) => ({ ...previous, address: selectedAsset.address, loading: true, error: null }));
    try {
      const response = await fetch(`/api/quote?${params}`, { cache: 'no-store', signal });
      const payload = await response.json();
      if (!response.ok || payload?.error) throw new Error(payload?.error || 'Executable quote unavailable');
      const routes = Array.isArray(payload.availableRoutes) && payload.availableRoutes.length
        ? payload.availableRoutes
        : [payload];
      setQuoteResult({ address: selectedAsset.address, loading: false, routes, error: null, fetchedAt: numberOrNull(payload.quoteFetchedAt) || Date.now() });
    } catch (error) {
      if (signal?.aborted) return;
      setQuoteResult({ address: selectedAsset.address, loading: false, routes: [], error: error instanceof Error ? error.message : 'Executable quote unavailable', fetchedAt: null });
    }
  }, [address, chainId, isConnected, selectedAsset?.address]);

  useEffect(() => {
    // Required Recharts mount guard: browser dimensions must not differ between SSR and hydration.
    setMounted(true);
  }, []);

  useEffect(() => {
    if (assets.length && !assets.some((asset) => asset.address.toLowerCase() === selectedAddress.toLowerCase())) {
      setSelectedAddress(initialTickerAddress(assets));
    }
  }, [assets, selectedAddress]);

  useEffect(() => {
    if (!selectedAsset?.address) {
      setMarketResult({ address: '', timeframe, loading: false, candles: [], error: null, updatedAt: null, snapshot: null });
      return undefined;
    }
    let active = true;
    let controller = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      if (active) setMarketResult((previous) => ({
        ...previous,
        address: selectedAsset.address,
        timeframe,
        loading: previous.address.toLowerCase() !== selectedAsset.address.toLowerCase() || previous.timeframe !== timeframe,
        error: null,
      }));
      await refreshMarket(controller.signal);
    };
    void load();
    const timer = liveSync ? setInterval(() => { void load(); }, MARKET_SYNC_INTERVAL_MS) : null;
    return () => {
      active = false;
      controller?.abort();
      if (timer) clearInterval(timer);
    };
  }, [liveSync, refreshMarket, selectedAsset?.address, timeframe]);

  useEffect(() => {
    if (!selectedAsset?.address || !address || !isConnected || chainId !== 56) {
      setQuoteResult({ address: selectedAsset?.address || '', loading: false, routes: [], error: null, fetchedAt: null });
      return undefined;
    }
    let active = true;
    let controller = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      if (active) void refreshQuote(controller.signal);
    };
    void load();
    const timer = liveSync ? setInterval(() => { void load(); }, QUOTE_SYNC_INTERVAL_MS) : null;
    return () => {
      active = false;
      controller?.abort();
      if (timer) clearInterval(timer);
    };
  }, [address, chainId, isConnected, liveSync, refreshQuote, selectedAsset?.address]);

  useEffect(() => {
    if (!quoteResult.fetchedAt) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quoteResult.fetchedAt]);

  const analysisInput = useMemo(() => {
    if (!currentAsset) return null;
    const status = statusLabel(currentAsset).toLowerCase();
    const age = quoteResult.fetchedAt ? 0 : null;
    const venues = routeRows.length
      ? routeRows.slice(0, 8).map((route) => ({
          platform: route.vendor,
          status,
          referencePerShare: referencePrice,
          executablePerShare: route.sharePrice,
          referenceGap: route.gap,
          quoteAgeSeconds: age,
          stale: age == null || age >= REFRESH_QUOTE_TTL_MS / 1000,
          unreliable: route.gap != null && Math.abs(route.gap) > 20,
          quoteAvailable: route.sharePrice != null,
        }))
      : [{
          platform: currentAsset.platform,
          status,
          referencePerShare: referencePrice,
          executablePerShare: null,
          referenceGap: null,
          quoteAgeSeconds: null,
          stale: true,
          unreliable: false,
          quoteAvailable: false,
        }];
    return {
      ticker: currentAsset.ticker,
      company: currentAsset.name,
      spread: spreadPercent,
      statusMismatch: false,
      statuses: [status],
      venues,
    };
  }, [currentAsset, quoteResult.fetchedAt, referencePrice, routeRows, spreadPercent]);

  useEffect(() => {
    if (!analysisInput) return undefined;
    const controller = new AbortController();
    let active = true;
    setAnalysis({ loading: true, data: null, error: null });
    fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(analysisInput),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error || 'Analysis service unavailable');
        return payload;
      })
      .then((data) => { if (active) setAnalysis({ loading: false, data, error: null }); })
      .catch((error) => {
        if (!active || controller.signal.aborted) return;
        setAnalysis({ loading: false, data: null, error: error instanceof Error ? error.message : 'Analysis service unavailable' });
      });
    return () => { active = false; controller.abort(); };
  }, [analysisInput, analysisNonce]);

  useEffect(() => {
    if (!drawerOpen) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') setDrawerOpen(false); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const openExecution = useCallback((route = null) => {
    setDrawerRoute(route);
    setDrawerOpen(true);
  }, []);

  const openMarketTrade = useCallback((asset) => {
    setSelectedAddress(asset.address);
    setActiveTab('terminal');
    openExecution(null);
  }, [openExecution]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const copyAddress = useCallback(async (value) => {
    if (!value || !navigator?.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedAddress(value);
      setTimeout(() => setCopiedAddress(''), 1400);
    } catch {
      setCopiedAddress('');
    }
  }, []);

  const tone = analysis.data?.tone === 'caution' ? 'gold' : analysis.data?.tone === 'positive' ? 'green' : 'cyan';
  const walletLabel = isConnected && address ? `${address.slice(0, 6)}…${address.slice(-4)}` : 'Connect Wallet';
  const currentToken = currentAsset ? { address: currentAsset.address, symbol: currentAsset.ticker, name: currentAsset.name } : null;

  return (
    <>
      <style jsx global>{`
        .wolv-terminal { --wolv-bg: #05070b; --wolv-green: #00ffb2; --wolv-gold: #ffc700; --wolv-cyan: #00b7ff; background: var(--wolv-bg); color: #f8fafc; isolation: isolate; }
        .wolv-terminal * { box-sizing: border-box; }
        .wolv-terminal .glass-panel { background: linear-gradient(145deg, rgba(14,19,28,.86), rgba(7,10,15,.74)); border: 1px solid rgba(255,255,255,.08); box-shadow: 0 18px 60px rgba(0,0,0,.32), inset 0 1px 0 rgba(255,255,255,.035); backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); }
        .wolv-terminal .glass-specular { position:absolute; inset:0 12% auto; height:1px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.2),transparent); pointer-events:none; }
        .wolv-terminal .ambient-orb { position:absolute; width:34rem; height:34rem; border-radius:999px; filter:blur(110px); opacity:.12; pointer-events:none; z-index:-1; }
        .wolv-terminal .wolv-ticker-viewport { overflow:hidden; }
        .wolv-terminal .wolv-ticker-track { animation:wolv-ticker 44s linear infinite; }
        .wolv-terminal .wolv-ticker-viewport:hover .wolv-ticker-track { animation-play-state:paused; }
        .wolv-terminal .live-dot { width:7px; height:7px; flex:none; border-radius:50%; box-shadow:0 0 10px currentColor; animation:wolv-live-pulse 1.9s ease-in-out infinite; }
        .wolv-terminal .chart-stage { width:100%; position:relative; }
        .wolv-terminal .tab-indicator { box-shadow:inset 0 -2px 0 var(--wolv-green), 0 8px 22px rgba(0,255,178,.08); }
        .wolv-terminal .lens-radar { background:repeating-radial-gradient(circle at center,rgba(0,183,255,.12) 0 1px,transparent 1px 33px); }
        .wolv-terminal .route-dash { stroke-dasharray:6 6; animation:wolv-flow 1.4s linear infinite; }
        .wolv-terminal .directory-row { transition:background .18s ease,border-color .18s ease,transform .18s ease; }
        .wolv-terminal .directory-row:hover { background:rgba(255,255,255,.045); border-color:rgba(0,183,255,.22); transform:translateY(-1px); }
        .wolv-terminal .drawer-backdrop { animation:wolv-fade .18s ease-out both; }
        .wolv-terminal .drawer-panel { animation:wolv-slide-in .28s cubic-bezier(.2,.72,.18,1) both; }
        .wolv-terminal .control-focus:focus-visible { outline:2px solid rgba(0,255,178,.75); outline-offset:3px; }
        .wolv-terminal select option { background:#0a0d14; color:#f8fafc; }
        @keyframes wolv-ticker { to { transform:translateX(-50%); } }
        @keyframes wolv-live-pulse { 0%,100% { opacity:1; box-shadow:0 0 0 0 rgba(0,255,178,.25); } 50% { opacity:.68; box-shadow:0 0 0 5px rgba(0,255,178,0); } }
        @keyframes wolv-flow { to { stroke-dashoffset:-24; } }
        @keyframes wolv-fade { from { opacity:0; } to { opacity:1; } }
        @keyframes wolv-slide-in { from { opacity:.65; transform:translateX(24px); } to { opacity:1; transform:translateX(0); } }
        @media (max-width:640px) { .wolv-terminal .glass-panel { border-radius:18px; } }
        @media (prefers-reduced-motion:reduce) { .wolv-terminal *, .wolv-terminal *::before, .wolv-terminal *::after { animation-duration:.01ms !important; animation-iteration-count:1 !important; scroll-behavior:auto !important; transition-duration:.01ms !important; } }
      `}</style>

      <div className="wolv-terminal relative min-h-screen overflow-hidden pb-10 font-sans antialiased selection:bg-[#00FFB2]/25">
        <div className="ambient-orb -left-48 -top-40 bg-[#FFC700]" aria-hidden="true" />
        <div className="ambient-orb -right-56 top-[36rem] bg-[#00B7FF]" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-0 -z-10 opacity-[0.22] [background-image:linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] [background-size:38px_38px] [mask-image:linear-gradient(to_bottom,black,transparent_78%)]" />

        <TickerTape assets={featuredAssets} onSelect={selectAsset} />

        <header className="sticky top-0 z-40 border-b border-white/[0.07] bg-[#05070b]/90 backdrop-blur-2xl">
          <div className="mx-auto flex max-w-[1480px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <Link href="/" className="group flex min-w-0 items-center gap-3" aria-label="WOLV home">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-[#FFC700]/80 bg-[#FFC700]/[0.07] text-lg font-black text-[#FFC700] shadow-[0_0_22px_rgba(255,199,0,.14)] transition group-hover:shadow-[0_0_30px_rgba(255,199,0,.26)]">W</span>
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-sm font-black tracking-[0.22em] text-white sm:text-base">WOLV</span>
                  <span className="hidden rounded border border-[#FFC700]/25 bg-[#FFC700]/[0.07] px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-[0.12em] text-[#FFC700] min-[420px]:inline">RWA terminal</span>
                </span>
                <span className="block truncate text-[9px] font-mono uppercase tracking-[0.15em] text-slate-500">BSC · spot equities</span>
              </span>
            </Link>

            <div className="flex items-center gap-2 sm:gap-3">
              <button type="button" role="switch" aria-checked={liveSync} onClick={() => setLiveSync((value) => !value)} className={`control-focus inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[9px] font-black tracking-[0.12em] transition ${liveSync ? 'border-[#00FFB2]/25 bg-[#00FFB2]/[0.07] text-[#00FFB2]' : 'border-white/10 bg-white/[0.03] text-slate-500'}`}>
                <span className={`size-1.5 rounded-full ${liveSync ? 'animate-pulse bg-[#00FFB2]' : 'bg-slate-600'}`} /> LIVE SYNC <span className="hidden sm:inline">{liveSync ? 'ON' : 'OFF'}</span>
              </button>
              <button type="button" onClick={() => openExecution(null)} className="control-focus inline-flex h-10 items-center gap-2 rounded-xl bg-[#00FFB2] px-3.5 text-[11px] font-black text-[#03110d] shadow-[0_0_24px_rgba(0,255,178,.16)] transition hover:-translate-y-0.5 hover:bg-[#6dffd2] sm:px-4 sm:text-xs">
                <Wallet className="size-4" /> <span className="max-w-[115px] truncate">{walletLabel}</span>
              </button>
            </div>
          </div>

          <div className="mx-auto max-w-[1480px] overflow-x-auto px-4 sm:px-6 lg:px-8">
            <nav role="tablist" aria-label="Terminal views" className="flex min-w-max items-center gap-1">
              {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
                <button key={id} role="tab" type="button" aria-selected={activeTab === id} onClick={() => setActiveTab(id)} className={`control-focus inline-flex items-center gap-2 border-b-2 px-3 py-3 text-[10px] font-bold tracking-wide transition sm:px-5 sm:text-xs ${activeTab === id ? 'tab-indicator border-transparent text-white' : 'border-transparent text-slate-500 hover:text-slate-200'}`}>
                  <Icon className={`size-3.5 ${activeTab === id ? 'text-[#00FFB2]' : ''}`} />{label}
                </button>
              ))}
              <div className="ml-auto hidden items-center gap-2 pb-2 text-[9px] font-mono uppercase tracking-[0.13em] text-slate-600 lg:flex">
                <span className="size-1.5 rounded-full bg-[#00B7FF]" /> {assets.length.toLocaleString()} eligible assets
              </div>
            </nav>
          </div>
        </header>

        <main className={`relative z-10 mx-auto w-full px-4 pt-5 sm:px-6 sm:pt-7 lg:px-8 ${activeTab === 'lens' ? 'max-w-[1600px]' : 'max-w-[1480px]'}`}>
          {feedError && (
            <div role="status" className="mb-5 flex items-start gap-3 rounded-xl border border-[#FFC700]/25 bg-[#FFC700]/[0.07] p-4 text-xs leading-relaxed text-[#FFC700]">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>Live RWA asset feed is unavailable. This workspace will not infer or substitute assets. {feedError}</span>
            </div>
          )}

          {activeTab === 'terminal' && selectedAsset && currentAsset && (
            <TerminalView
              assets={assets}
              featuredAssets={featuredAssets}
              selectedAsset={currentAsset}
              listedPrice={listedPrice}
              referencePrice={referencePrice}
              listedPerShare={listedPerShare}
              shareRatio={shareRatio}
              timeframe={timeframe}
              setTimeframe={setTimeframe}
              chartCandles={chartCandles}
              marketResult={marketResult}
              mounted={mounted}
              routeRows={routeRows}
              bestRoute={bestRoute}
              spreadPercent={spreadPercent}
              quoteResult={quoteResult}
              quoteIsFresh={quoteIsFresh}
              quoteAgeSeconds={quoteAgeSeconds}
              analysis={analysis}
              analysisTone={tone}
              onSelectAsset={selectAsset}
              onExecute={() => openExecution(bestRoute)}
              onTradeRoute={openExecution}
              onRefreshMarket={() => { void refreshMarket(); }}
              onRefreshAnalysis={() => setAnalysisNonce((value) => value + 1)}
            />
          )}

          {activeTab === 'terminal' && !selectedAsset && (
            <GlassPanel className="mx-auto max-w-4xl p-6 sm:p-10">
              <Badge tone="gold"><AlertTriangle className="size-3" /> Terminal data status</Badge>
              <h1 className="mt-4 text-3xl font-black tracking-tight text-white">WOLV Terminal</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">The verified asset list is unavailable, so no tickers, prices, charts, or execution venues are being invented.</p>
              <div className="mt-6"><EmptyData title="Waiting for verified BSC RWA data" body={feedError || 'Refresh when the Binance RWA asset feed is available.'} /></div>
            </GlassPanel>
          )}

          {activeTab === 'markets' && (
            <MemoMarketsView
              assets={assets}
              filteredAssets={filteredAssets}
              featuredAssets={featuredAssets}
              searchTerm={searchTerm}
              setSearchTerm={setSearchTerm}
              platformFilter={platformFilter}
              setPlatformFilter={setPlatformFilter}
              sessionFilter={sessionFilter}
              setSessionFilter={setSessionFilter}
              sortMode={sortMode}
              setSortMode={setSortMode}
              marketPlatforms={marketPlatforms}
              selectedAddress={selectedAsset?.address || ''}
              onSelectAsset={selectAsset}
              onTrade={openMarketTrade}
              copiedAddress={copiedAddress}
              onCopyAddress={copyAddress}
              feedError={feedError}
            />
          )}

          {activeTab === 'lens' && (
            <LensView
              assets={assets}
              currentAsset={currentAsset}
              sessionCounts={sessionCounts}
              routeRows={routeRows}
              spreadPercent={spreadPercent}
              quoteResult={quoteResult}
              quoteIsFresh={quoteIsFresh}
              quoteAgeSeconds={quoteAgeSeconds}
              chartCandles={chartCandles}
              timeframe={timeframe}
              realizedVolatility={realizedVolatility}
              analysis={analysis}
              analysisTone={tone}
              onRefreshAnalysis={() => setAnalysisNonce((value) => value + 1)}
              onOpenExecution={() => openExecution(bestRoute)}
              onSelectMarkets={() => setActiveTab('markets')}
            />
          )}

          <footer className="mx-auto mt-8 flex max-w-7xl flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] py-4 text-[9px] leading-relaxed text-slate-600">
            <span>Market figures are sourced from Binance Web3. Quotes are wallet-bound, short-lived, and may change before execution.</span>
            <span className="font-mono">WOLV · BSC MAINNET</span>
          </footer>
        </main>

        {drawerOpen && currentToken && (
          <div className="drawer-backdrop fixed inset-0 z-[100] flex justify-end bg-black/70 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}>
            <section role="dialog" aria-modal="true" aria-labelledby="execution-drawer-title" className="drawer-panel flex h-full w-full max-w-[560px] flex-col border-l border-white/10 bg-[#080b10] shadow-[-24px_0_80px_rgba(0,0,0,.55)]">
              <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] p-5 sm:p-6">
                <div className="min-w-0">
                  <div className="mb-2 flex items-center gap-2"><Badge tone="green"><LockKeyhole className="size-3" /> Wallet-controlled</Badge></div>
                  <h2 id="execution-drawer-title" className="text-xl font-black tracking-tight text-white">Trade {currentToken.symbol}</h2>
                  <p className="mt-1 truncate text-xs text-slate-500">{currentToken.name} · BNB Smart Chain</p>
                  {drawerRoute?.vendor && <p className="mt-2 text-[10px] font-semibold text-[#00B7FF]">Selected venue preview: {drawerRoute.vendor} · refreshed before any signing</p>}
                  <p className="mt-2 max-w-md text-[10px] leading-relaxed text-slate-500">The route preview is indicative. The execution panel requests a fresh quote and preflight; nothing is signed or sent until you approve it in your wallet.</p>
                </div>
                <button type="button" aria-label="Close execution drawer" onClick={closeDrawer} className="control-focus grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 text-slate-400 transition hover:border-white/20 hover:text-white"><X className="size-4" /></button>
              </div>
              <div className="drawer-scroll min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                <GlassPanel className="mb-4 p-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div><div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">On-chain token price</div><div className="mt-1 font-mono text-sm font-bold text-white">{money(listedPrice, 4)}</div></div>
                    <div><div className="text-[9px] uppercase tracking-[0.14em] text-slate-500">Reference / share</div><div className="mt-1 font-mono text-sm font-bold text-white">{money(referencePrice, 4)}</div></div>
                  </div>
                </GlassPanel>
                <TradeButton token={currentToken} />
              </div>
            </section>
          </div>
        )}
      </div>
    </>
  );
}

function TerminalView({
  assets,
  featuredAssets,
  selectedAsset,
  listedPrice,
  referencePrice,
  listedPerShare,
  shareRatio,
  timeframe,
  setTimeframe,
  chartCandles,
  marketResult,
  mounted,
  routeRows,
  bestRoute,
  spreadPercent,
  quoteResult,
  quoteIsFresh,
  quoteAgeSeconds,
  analysis,
  analysisTone,
  onSelectAsset,
  onExecute,
  onTradeRoute,
  onRefreshMarket,
  onRefreshAnalysis,
}) {
  const status = statusTone(selectedAsset);
  const isCurrentQuote = quoteResult.address.toLowerCase() === selectedAsset.address.toLowerCase();
  const quoteAvailable = routeRows.length > 0;
  return (
    <div className="space-y-5 sm:space-y-6">
      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(300px,.75fr)]">
        <div className="relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#090d13]/80 p-5 shadow-[0_22px_75px_rgba(0,0,0,.38)] backdrop-blur-2xl sm:p-7">
          <div className="pointer-events-none absolute -right-20 -top-32 size-80 rounded-full bg-[#FFC700]/[0.11] blur-[100px]" />
          <div className="pointer-events-none absolute bottom-0 left-1/3 h-px w-1/2 bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          <div className="relative">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Badge tone={status === 'warn' ? 'gold' : status === 'open' ? 'green' : 'cyan'} pulse={status === 'open'}>{statusLabel(selectedAsset)}</Badge>
                  <Badge tone="cyan"><Clock3 className="size-3" />{quoteAvailable ? (quoteIsFresh ? `Quote ${quoteAgeSeconds}s old` : `Quote stale · ${quoteAgeSeconds}s`) : 'Reference snapshot'}</Badge>
                </div>
                <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
                  <div>
                    <h1 className="text-3xl font-black tracking-tight text-white sm:text-5xl">{selectedAsset.ticker}</h1>
                    <p className="mt-1 max-w-2xl text-xs text-slate-500 sm:text-sm">{selectedAsset.name} <span className="text-slate-700">·</span> <span className="capitalize">{selectedAsset.platform}</span></p>
                  </div>
                  <div className="pb-0.5">
                    <div className="font-mono text-3xl font-black tracking-tight text-white sm:text-4xl">{money(listedPrice, 2)}</div>
                    <div className="mt-1 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-500">On-chain token price</div>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" onClick={onRefreshMarket} className="control-focus grid size-9 place-items-center rounded-xl border border-white/10 text-slate-400 transition hover:border-[#00B7FF]/30 hover:text-[#61D3FF]" aria-label="Refresh market data" title="Refresh Binance market data"><RefreshCw className={`size-4 ${marketResult.loading ? 'animate-spin' : ''}`} /></button>
                <button type="button" onClick={onExecute} disabled={!selectedAsset.address} className="control-focus inline-flex h-10 items-center gap-2 rounded-xl bg-[#00FFB2] px-4 text-[10px] font-black uppercase tracking-[0.1em] text-[#03110d] shadow-[0_0_26px_rgba(0,255,178,.14)] transition hover:-translate-y-0.5 hover:shadow-[0_8px_35px_rgba(0,255,178,.22)] disabled:cursor-not-allowed disabled:opacity-40 sm:text-xs">
                  <Zap className="size-4" /> Execute Best Route
                </button>
              </div>
            </div>

            <div className="mt-6 flex gap-2 overflow-x-auto pb-1">
              {featuredAssets.map((asset) => {
                const active = asset.address.toLowerCase() === selectedAsset.address.toLowerCase();
                return (
                  <button key={asset.address} type="button" onClick={() => onSelectAsset(asset.address)} className={`control-focus flex min-w-[142px] shrink-0 items-center gap-3 rounded-2xl border px-3 py-3 text-left transition sm:min-w-[172px] sm:px-4 ${active ? 'border-[#FFC700]/70 bg-[#FFC700]/[0.07] shadow-[0_0_26px_rgba(255,199,0,.08)]' : 'border-white/[0.07] bg-white/[0.025] hover:border-white/20'}`}>
                    <span className={`grid size-9 shrink-0 place-items-center rounded-xl text-[10px] font-black ${active ? 'bg-[#FFC700]/15 text-[#FFC700]' : 'bg-white/[0.06] text-slate-400'}`}>{asset.ticker.slice(0, 3).toUpperCase()}</span>
                    <span className="min-w-0"><span className="block text-xs font-bold text-slate-200">{asset.ticker}</span><span className="mt-0.5 block font-mono text-xs text-white">{money(asset.tokenPrice)}</span></span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <GlassPanel className="flex flex-col justify-between">
          <div>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-[#00FFB2]" /><h2 className="text-xs font-black uppercase tracking-[0.16em] text-white">Live AI Risk Guard</h2></div>
              <Badge tone={analysisTone} pulse={analysis.loading}>{analysis.loading ? 'Scanning' : analysis.data?.source || 'Risk engine'}</Badge>
            </div>
            {analysis.loading && !analysis.data ? (
              <div className="flex min-h-28 items-center gap-3 text-xs text-slate-500"><LoaderCircle className="size-4 animate-spin text-[#00B7FF]" /> Evaluating current session, quote freshness and route data…</div>
            ) : analysis.error ? (
              <div className="rounded-xl border border-[#FFC700]/20 bg-[#FFC700]/[0.05] p-3 text-xs leading-relaxed text-[#FFC700]">Risk analysis unavailable: {analysis.error}. Verify session status and refresh before trading.</div>
            ) : (
              <>
                <h3 className="text-lg font-black leading-snug text-white sm:text-xl">{analysis.data?.headline || 'Waiting for verified market data'}</h3>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{analysis.data?.summary || 'No analysis is shown until Binance returns a supported asset and market snapshot.'}</p>
                {analysis.data?.reasons?.length > 0 && <ul className="mt-3 space-y-2">{analysis.data.reasons.slice(0, 3).map((reason, index) => <li key={`${index}-${reason}`} className="flex gap-2 text-[11px] leading-relaxed text-slate-400"><span className="mt-1 size-1.5 shrink-0 rounded-full bg-[#FFC700]" />{reason}</li>)}</ul>}
              </>
            )}
          </div>
          <div className="mt-5 flex items-center justify-between gap-3 border-t border-white/[0.07] pt-4">
            <span className="text-[10px] leading-relaxed text-slate-500">Informational only · confirm a fresh wallet quote before signing.</span>
            <button type="button" onClick={onRefreshAnalysis} className="control-focus inline-flex shrink-0 items-center gap-1.5 text-[10px] font-bold text-[#00B7FF] transition hover:text-white"><RefreshCw className="size-3" />Recheck</button>
          </div>
        </GlassPanel>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.75fr)]">
        <div className="space-y-5 sm:space-y-6">
          <GlassPanel className="chart-panel p-4 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div><div className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-500">Market chart</div><div className="mt-1 text-sm font-bold text-white">{selectedAsset.ticker} <span className="font-normal text-slate-500">· on-chain close</span></div></div>
              <div className="inline-flex rounded-xl border border-white/[0.08] bg-black/30 p-1" role="group" aria-label="Chart timeframe">
                {TIMEFRAMES.map((range) => <button key={range} type="button" onClick={() => setTimeframe(range)} aria-pressed={timeframe === range} className={`control-focus rounded-lg px-3 py-2 text-[10px] font-bold transition ${timeframe === range ? 'bg-white/[0.09] text-[#FFC700]' : 'text-slate-500 hover:text-white'}`}>{range}</button>)}
              </div>
            </div>
            <MarketChart candles={chartCandles} ticker={selectedAsset.ticker} timeframe={timeframe} mounted={mounted} loading={marketResult.loading} error={marketResult.error} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[9px] text-slate-600">
              <span>{marketResult.updatedAt ? `Binance snapshot ${new Date(marketResult.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Waiting for first verified snapshot'}</span>
              <span>Volume bars intentionally omitted when the source does not return them.</span>
            </div>
          </GlassPanel>

          <GlassPanel>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div><div className="flex items-center gap-2"><ArrowDownUp className="size-4 text-[#00B7FF]" /><h2 className="text-xs font-black uppercase tracking-[0.16em] text-white">On-chain execution route</h2></div><p className="mt-1 text-[10px] text-slate-500">A live wallet quote is required before any executable route is shown.</p></div>
              {bestRoute && <Badge tone={quoteIsFresh ? 'green' : 'gold'}>{quoteIsFresh ? 'Quote fresh' : 'Quote expired'}</Badge>}
            </div>
            <RouteFlow asset={selectedAsset} bestRoute={bestRoute} hasWalletQuote={quoteAvailable && quoteIsFresh} />
          </GlassPanel>
        </div>

        <div className="space-y-5 sm:space-y-6">
          <GlassPanel>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><Layers3 className="size-4 text-[#00B7FF]" /><h2 className="text-xs font-black uppercase tracking-[0.16em] text-white">Executable Venues</h2></div><p className="mt-1 text-[10px] text-slate-500">Wallet-bound routes · fixed {QUOTE_AMOUNT_USDT} USDT indicative notional</p></div>
              {quoteResult.loading && <LoaderCircle className="size-4 animate-spin text-[#00B7FF]" />}
            </div>
            {!isCurrentQuote || (!quoteAvailable && !quoteResult.error && !quoteResult.loading) ? (
              <div className="rounded-xl border border-[#00B7FF]/15 bg-[#00B7FF]/[0.04] p-4">
                <div className="flex items-center gap-2 text-xs font-bold text-white"><LockKeyhole className="size-4 text-[#00B7FF]" />Connect on BNB Smart Chain</div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">Binance RFQ quotes require the intended receiver wallet. The reference snapshot is shown above; no venue is labeled executable until a wallet-bound quote succeeds.</p>
                <button type="button" onClick={onExecute} className="control-focus mt-4 inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.1em] text-[#00FFB2] hover:text-white">Open trade panel <ArrowRight className="size-3.5" /></button>
              </div>
            ) : quoteResult.error ? (
              <div role="status" className="rounded-xl border border-[#FFC700]/20 bg-[#FFC700]/[0.05] p-4 text-xs leading-relaxed text-[#FFC700]">Live route unavailable: {quoteResult.error}. No indicative route is presented as executable.</div>
            ) : !routeRows.length ? (
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4 text-xs text-slate-500">No valid executable routes were returned for this asset.</div>
            ) : (
              <div className="space-y-2">
                {routeRows.slice(0, 6).map((route, index) => (
                  <div key={`${route.vendor}-${index}`} className={`rounded-xl border p-3 transition ${index === 0 ? 'border-[#00FFB2]/20 bg-[#00FFB2]/[0.035]' : 'border-white/[0.06] bg-white/[0.02]'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-xs font-bold text-white">{route.vendor}</span><Badge tone={route.mode === 'RFQ' ? 'gold' : 'cyan'}>{route.mode}</Badge>{index === 0 && <span className="text-[8px] font-black uppercase tracking-wider text-[#00FFB2]">Best output</span>}</div><div className="mt-1 text-[9px] text-slate-500">{route.gap == null ? 'Share ratio unavailable' : `${route.gap >= 0 ? '+' : ''}${route.gap.toFixed(3)}% vs reference/share`}</div></div>
                      <div className="shrink-0 text-right"><div className="font-mono text-sm font-bold text-white">{money(route.sharePrice, 4)}</div><div className="text-[9px] uppercase tracking-wider text-slate-600">per share</div></div>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-white/[0.05] pt-2">
                      <span className="text-[9px] text-slate-500">Impact {route.impact == null ? '—' : `${route.impact}%`} · {quoteIsFresh ? `${quoteAgeSeconds}s` : 'stale'}</span>
                      <button type="button" onClick={() => onTradeRoute(route)} className="control-focus inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-[0.09em] text-[#00FFB2] hover:text-white">Trade Route <ArrowUpRight className="size-3" /></button>
                    </div>
                  </div>
                ))}
                {spreadPercent != null && <div className="flex items-center justify-between rounded-lg bg-white/[0.025] px-3 py-2 text-[10px]"><span className="text-slate-500">Quoted cross-venue range</span><span className="font-mono font-bold text-[#00B7FF]">{spreadPercent.toFixed(3)}%</span></div>}
                <p className="text-[9px] leading-relaxed text-slate-600">Indicative quotes can expire or change. The trade panel fetches its own fresh quote and preflight before the wallet asks you to sign.</p>
              </div>
            )}
          </GlassPanel>

          <GlassPanel>
            <div className="mb-4 flex items-center justify-between gap-3"><div><div className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-500">Reference context</div><div className="mt-1 text-sm font-black text-white">Price integrity</div></div><ShieldCheck className="size-4 text-[#00FFB2]" /></div>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] pb-3"><span className="text-[11px] text-slate-500">On-chain token price</span><span className="font-mono text-sm font-bold text-white">{money(listedPrice, 4)}</span></div>
              <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] pb-3"><span className="text-[11px] text-slate-500">Binance reference / share</span><span className="font-mono text-sm font-bold text-white">{money(referencePrice, 4)}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="text-[11px] text-slate-500">Issuer ratio</span><span className="font-mono text-xs font-bold text-[#00B7FF]">{shareRatio == null ? '—' : `${shareRatio.toFixed(6)} shares / token`}</span></div>
            </div>
            <p className="mt-4 text-[9px] leading-relaxed text-slate-600">Reference price is an issuer-derived reference value, not an official stock-exchange quote. {listedPerShare != null ? `Listed token price normalized per share: ${money(listedPerShare, 4)}.` : 'A per-share token price is withheld until a valid issuer ratio is available.'}</p>
          </GlassPanel>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatBlock label="Eligible assets" value={assets.length.toLocaleString()} note="Verified spot assets from the upstream list" icon={Database} accent="cyan" />
        <StatBlock label="Selected issuer" value={selectedAsset.platform} note={`${selectedAsset.ticker} · BSC`} icon={Layers3} accent="gold" />
        <StatBlock label="Quote status" value={quoteAvailable ? (quoteIsFresh ? 'Wallet-bound' : 'Expired') : 'Not quoted'} note={quoteAvailable ? `Updated ${quoteAgeSeconds ?? 0}s ago` : 'Connect a wallet to request RFQ routes'} icon={Clock3} accent={quoteAvailable && quoteIsFresh ? 'green' : 'gold'} />
        <StatBlock label="Market session" value={statusLabel(selectedAsset)} note="Status supplied by Binance RWA data" icon={CircleDot} accent={status === 'warn' ? 'gold' : 'cyan'} />
      </section>
    </div>
  );
}

function RouteFlow({ asset, bestRoute, hasWalletQuote }) {
  const target = asset?.ticker || 'Selected token';
  const venue = hasWalletQuote ? (bestRoute?.vendor || 'Best available route') : 'Awaiting wallet-bound quote';
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/25 p-4 sm:p-5">
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.025] p-4 text-center">
          <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-600">Input asset</div>
          <div className="mt-2 flex items-center justify-center gap-2 text-sm font-bold text-white"><Wallet className="size-4 text-[#00B7FF]" /> USDT · BSC</div>
          <div className="mt-1 text-[9px] font-mono text-slate-500">{QUOTE_AMOUNT_USDT} USDT quote notional</div>
        </div>
        <div className="hidden md:block"><ArrowRight className="size-4 text-[#00B7FF]" /></div>
        <div className="rounded-xl border border-[#00B7FF]/20 bg-[#00B7FF]/[0.045] p-4 text-center">
          <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#61D3FF]">WOLV routing</div>
          <div className="mt-2 text-sm font-black text-white">Binance Aggregator</div>
          <div className="mt-1 text-[9px] font-mono text-slate-500">Quote → preflight → user approval</div>
        </div>
        <div className="hidden md:block"><ArrowRight className="size-4 text-[#00B7FF]" /></div>
        <div className="rounded-xl border border-[#FFC700]/20 bg-[#FFC700]/[0.035] p-4 text-center">
          <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-[#FFC700]">Selected venue</div>
          <div className="mt-2 text-sm font-black text-white">{venue}</div>
          <div className="mt-1 truncate text-[9px] font-mono text-slate-500">Output · {target}</div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[9px] leading-relaxed text-slate-600"><span>On-chain route is not pre-authorized. No transaction is sent by this diagram.</span><span>{hasWalletQuote ? 'Fresh quote expires; re-quote before execution.' : 'Connect the receiving wallet to resolve venues.'}</span></div>
    </div>
  );
}

function MarketsView({
  assets,
  filteredAssets,
  featuredAssets,
  searchTerm,
  setSearchTerm,
  platformFilter,
  setPlatformFilter,
  sessionFilter,
  setSessionFilter,
  sortMode,
  setSortMode,
  marketPlatforms,
  selectedAddress,
  onSelectAsset,
  onTrade,
  copiedAddress,
  onCopyAddress,
  feedError,
}) {
  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[26px] border border-white/[0.08] bg-[#090d13]/78 p-6 shadow-[0_22px_75px_rgba(0,0,0,.34)] backdrop-blur-2xl sm:p-8">
        <div className="pointer-events-none absolute -right-10 -top-28 size-72 rounded-full bg-[#00B7FF]/[0.09] blur-[90px]" />
        <div className="relative flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-3xl"><Badge tone="cyan"><Database className="size-3" /> Verified BSC asset feed</Badge><h1 className="mt-4 text-3xl font-black tracking-tight text-white sm:text-4xl">Markets Directory</h1><p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">Search every eligible tokenized spot asset returned by the live Binance RWA list. Prices and issuer sessions remain source-labeled; no unsupported assets are inferred.</p></div>
          <div className="rounded-2xl border border-[#00B7FF]/20 bg-[#00B7FF]/[0.04] px-5 py-4"><div className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">Directory coverage</div><div className="mt-1 text-3xl font-black text-white">{assets.length.toLocaleString()}</div><div className="text-[10px] text-slate-500">eligible BSC assets</div></div>
        </div>
      </section>

      {featuredAssets.length > 0 && <div className="flex gap-2 overflow-x-auto pb-1">{featuredAssets.slice(0, 5).map((asset) => <button key={asset.address} type="button" onClick={() => onSelectAsset(asset.address)} className={`control-focus shrink-0 rounded-full border px-3 py-2 text-[10px] font-bold transition ${asset.address === selectedAddress ? 'border-[#00FFB2]/30 bg-[#00FFB2]/[0.07] text-[#00FFB2]' : 'border-white/[0.07] bg-white/[0.02] text-slate-400 hover:text-white'}`}>{asset.ticker} <span className="ml-1 font-mono text-slate-600">{money(asset.tokenPrice)}</span></button>)}</div>}

      <GlassPanel className="p-4 sm:p-5">
        <div className="grid gap-3 lg:grid-cols-[minmax(220px,1.5fr)_repeat(3,minmax(140px,.7fr))_auto]">
          <label className="relative block">
            <span className="sr-only">Search ticker, issuer, or contract</span><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
            <input type="search" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search ticker, company, issuer, contract…" className="control-focus h-11 w-full rounded-xl border border-white/[0.08] bg-black/25 pl-10 pr-3 text-xs text-white placeholder:text-slate-600" />
          </label>
          <label className="relative"><span className="sr-only">Filter by issuer</span><select value={platformFilter} onChange={(event) => setPlatformFilter(event.target.value)} className="control-focus h-11 w-full appearance-none rounded-xl border border-white/[0.08] bg-black/25 px-3 pr-9 text-xs text-slate-300"><option value="all">All issuers</option>{marketPlatforms.filter((platform) => platform !== 'all').map((platform) => <option key={platform} value={platform}>{platform}</option>)}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" /></label>
          <label className="relative"><span className="sr-only">Filter by session</span><select value={sessionFilter} onChange={(event) => setSessionFilter(event.target.value)} className="control-focus h-11 w-full appearance-none rounded-xl border border-white/[0.08] bg-black/25 px-3 pr-9 text-xs text-slate-300"><option value="all">All sessions</option><option value="open">Open / trading</option><option value="closed">Closed / paused</option><option value="unknown">Status unavailable</option></select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" /></label>
          <label className="relative"><span className="sr-only">Sort directory</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value)} className="control-focus h-11 w-full appearance-none rounded-xl border border-white/[0.08] bg-black/25 px-3 pr-9 text-xs text-slate-300"><option value="ticker">Ticker A–Z</option><option value="marketCap">Largest market cap</option><option value="price">Highest token price</option></select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" /></label>
          <button type="button" onClick={() => { setSearchTerm(''); setPlatformFilter('all'); setSessionFilter('all'); setSortMode('ticker'); }} className="control-focus inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-white/[0.08] px-4 text-[10px] font-bold text-slate-400 transition hover:border-white/20 hover:text-white"><Filter className="size-3.5" /> Reset</button>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-3 text-[10px] text-slate-500"><span>Showing <b className="text-white">{filteredAssets.length.toLocaleString()}</b> of {assets.length.toLocaleString()} assets</span><span>Indicative issuer data · not investment advice</span></div>
      </GlassPanel>

      {feedError && <div role="status" className="rounded-xl border border-[#FFC700]/20 bg-[#FFC700]/[0.05] p-4 text-xs leading-relaxed text-[#FFC700]">The live directory feed could not be refreshed. No fallback symbols or prices are shown.</div>}
      {filteredAssets.length === 0 ? <EmptyData title={feedError ? 'Directory feed unavailable' : 'No matching assets'} body={feedError || 'Try a different ticker, issuer, or session filter.'} /> : (
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Eligible BSC tokenized asset directory">
          {filteredAssets.map((asset) => {
            const selected = asset.address.toLowerCase() === selectedAddress.toLowerCase();
            const session = statusTone(asset);
            return (
              <article key={asset.address} className={`directory-row rounded-2xl border bg-[#080b10]/75 p-4 ${selected ? 'border-[#00FFB2]/30 shadow-[0_0_25px_rgba(0,255,178,.055)]' : 'border-white/[0.07]'}`}>
                <div className="flex items-start justify-between gap-3">
                  <button type="button" onClick={() => onSelectAsset(asset.address)} className="control-focus flex min-w-0 items-center gap-3 text-left">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-white/[0.07] bg-white/[0.035] text-[10px] font-black text-[#FFC700]">{asset.ticker.slice(0, 3).toUpperCase()}</span>
                    <span className="min-w-0"><span className="block truncate text-sm font-black text-white">{asset.ticker}</span><span className="mt-0.5 block max-w-[220px] truncate text-[10px] text-slate-500">{asset.name}</span></span>
                  </button>
                  <Badge tone={session === 'open' ? 'green' : session === 'warn' ? 'gold' : 'cyan'}>{statusLabel(asset)}</Badge>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 border-y border-white/[0.06] py-3">
                  <div><div className="text-[9px] uppercase tracking-[0.12em] text-slate-600">Token price</div><div className="mt-1 font-mono text-sm font-bold text-white">{money(asset.tokenPrice, 4)}</div></div>
                  <div><div className="text-[9px] uppercase tracking-[0.12em] text-slate-600">Reference / share</div><div className="mt-1 font-mono text-sm font-bold text-white">{money(normalizePerSharePrice(asset.referencePrice, asset.tokenToShareRatio), 4)}</div></div>
                  <div><div className="text-[9px] uppercase tracking-[0.12em] text-slate-600">24h volume</div><div className="mt-1 text-xs font-semibold text-slate-300">{compactMoney(asset.volume24H)}</div></div>
                  <div><div className="text-[9px] uppercase tracking-[0.12em] text-slate-600">Issuer</div><div className="mt-1 truncate text-xs font-semibold capitalize text-[#00B7FF]">{asset.platform}</div></div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <button type="button" onClick={() => onCopyAddress(asset.address)} className="control-focus inline-flex min-w-0 items-center gap-1.5 truncate font-mono text-[9px] text-slate-600 transition hover:text-slate-300" title={asset.address}>{copiedAddress === asset.address ? <Check className="size-3 text-[#00FFB2]" /> : <span className="size-1.5 shrink-0 rounded-full bg-[#00B7FF]" />}{copiedAddress === asset.address ? 'Copied' : `${asset.address.slice(0, 8)}…${asset.address.slice(-6)}`}</button>
                  <div className="flex items-center gap-2"><button type="button" onClick={() => onSelectAsset(asset.address)} className="control-focus rounded-lg border border-white/[0.08] px-3 py-2 text-[9px] font-bold text-slate-300 transition hover:border-white/20 hover:text-white">Analyze</button><button type="button" onClick={() => onTrade(asset)} className="control-focus rounded-lg bg-[#00FFB2] px-3 py-2 text-[9px] font-black text-[#03110d] transition hover:bg-[#6dffd2]">Trade</button></div>
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}

const MemoMarketsView = memo(MarketsView);

function LensView({
  assets,
  currentAsset,
  sessionCounts,
  routeRows,
  spreadPercent,
  quoteResult,
  quoteIsFresh,
  quoteAgeSeconds,
  chartCandles,
  timeframe,
  realizedVolatility,
  analysis,
  analysisTone,
  onRefreshAnalysis,
  onOpenExecution,
  onSelectMarkets,
}) {
  const routesKnown = quoteResult.routes.length > 0 && routeRows.length > 0;
  const maxVolume = Math.max(1, ...assets.map((asset) => asset.volume24H || 0));
  const volumeDistribution = [...assets]
    .filter((asset) => asset.volume24H != null)
    .sort((a, b) => b.volume24H - a.volume24H)
    .slice(0, 8);
  return (
    <div className="space-y-6">
      <section className="relative overflow-hidden rounded-[26px] border border-[#00B7FF]/15 bg-[#070c12]/90 p-6 shadow-[0_25px_100px_rgba(0,0,0,.45)] sm:p-8">
        <div className="lens-radar pointer-events-none absolute -right-16 -top-24 size-[450px] rounded-full opacity-50" />
        <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-[#00B7FF]/[0.09] blur-[100px]" />
        <div className="relative flex flex-wrap items-end justify-between gap-6">
          <div><Badge tone="cyan" pulse><Sparkles className="size-3" /> Intelligence matrix · source-grounded</Badge><h1 className="mt-4 text-3xl font-black tracking-tight text-white sm:text-5xl">AI Live Lens</h1><p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">Session alignment, wallet-bound route dispersion, and realized candle volatility. Missing quotes or unknown market states are surfaced—not estimated.</p></div>
          <div className="flex items-center gap-2"><button type="button" onClick={onRefreshAnalysis} className="control-focus inline-flex h-10 items-center gap-2 rounded-xl border border-white/10 px-4 text-[10px] font-bold text-slate-300 transition hover:border-[#00B7FF]/30 hover:text-white"><RefreshCw className={`size-3.5 ${analysis.loading ? 'animate-spin' : ''}`} /> Re-run risk scan</button><button type="button" onClick={onOpenExecution} className="control-focus inline-flex h-10 items-center gap-2 rounded-xl bg-[#00FFB2] px-4 text-[10px] font-black text-[#03110d] transition hover:bg-[#6dffd2]">Open trade panel <ArrowRight className="size-3.5" /></button></div>
        </div>
        <div className="relative mt-7 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatBlock label="Assets monitored" value={assets.length.toLocaleString()} note="Current verified RWA directory" icon={Database} accent="cyan" />
          <StatBlock label="Open / trading" value={sessionCounts.open.toLocaleString()} note="Binance status open or regular" icon={Activity} accent="green" />
          <StatBlock label="Closed / paused" value={(sessionCounts.closed + sessionCounts.paused).toLocaleString()} note={`${sessionCounts.paused.toLocaleString()} paused or halted`} icon={AlertTriangle} accent="gold" />
          <StatBlock label="Unknown session" value={sessionCounts.unknown.toLocaleString()} note="Never classified as tradable" icon={Clock3} accent="cyan" />
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(330px,.85fr)]">
        <GlassPanel className="min-h-[410px]">
          <div className="mb-5 flex items-center justify-between gap-3"><div><div className="flex items-center gap-2"><ShieldAlert className="size-4 text-[#FFC700]" /><h2 className="text-xs font-black uppercase tracking-[0.15em] text-white">Selected asset risk panel</h2></div><div className="mt-1 text-[10px] text-slate-500">{currentAsset?.ticker || 'No asset selected'} · analysis from current verified inputs</div></div><Badge tone={analysisTone}>{analysis.data?.source || 'Awaiting scan'}</Badge></div>
          {analysis.loading && <div className="mb-4 flex items-center gap-2 text-[10px] text-slate-500"><LoaderCircle className="size-3.5 animate-spin" />Refreshing current risk analysis…</div>}
          {analysis.error ? <div role="status" className="rounded-xl border border-[#FFC700]/20 bg-[#FFC700]/[0.05] p-4 text-xs leading-relaxed text-[#FFC700]">{analysis.error}</div> : <>
            <h3 className="max-w-2xl text-2xl font-black leading-tight text-white">{analysis.data?.headline || 'Waiting for verified quote data'}</h3>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400">{analysis.data?.summary || 'Select an asset and connect a wallet to request actual RFQ routes. Until then, venue dispersion remains unavailable.'}</p>
            <div className="mt-5 space-y-3">{(analysis.data?.reasons || []).map((reason, index) => <div key={`${index}-${reason}`} className="flex gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 text-xs leading-relaxed text-slate-400"><span className="grid size-5 shrink-0 place-items-center rounded-md bg-[#00B7FF]/[0.08] text-[9px] font-black text-[#00B7FF]">0{index + 1}</span>{reason}</div>)}</div>
            <div className="mt-5 rounded-xl border border-white/[0.06] bg-black/25 p-4"><div className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-600">Next step</div><div className="mt-1 text-xs font-semibold text-slate-300">{analysis.data?.nextStep || 'Wait for a verified market snapshot.'}</div></div>
          </>}
        </GlassPanel>

        <GlassPanel>
          <div className="mb-5 flex items-center justify-between gap-3"><div><div className="flex items-center gap-2"><ArrowDownUp className="size-4 text-[#00B7FF]" /><h2 className="text-xs font-black uppercase tracking-[0.15em] text-white">Cross-venue spread checks</h2></div><div className="mt-1 text-[10px] text-slate-500">{routesKnown ? `Quote age ${quoteAgeSeconds}s` : 'Requires connected receiver wallet'}</div></div><Badge tone={routesKnown && quoteIsFresh ? 'green' : 'gold'}>{routesKnown ? (quoteIsFresh ? 'Fresh' : 'Stale') : 'Not available'}</Badge></div>
          {!routesKnown ? <EmptyData title="No wallet-bound venue quotes" body={quoteResult.error || 'Connect the receiving wallet to request supported RWA/RFQ routes. Reference prices are not used as substitute quotes.'} /> : <>
            <div className="grid grid-cols-2 gap-3"><StatBlock label="Routes returned" value={routeRows.length.toLocaleString()} note="Latest Binance aggregator response" icon={Layers3} accent="cyan" /><StatBlock label="Quoted range" value={spreadPercent == null ? '—' : `${spreadPercent.toFixed(3)}%`} note="Before gas, fees, and slippage" icon={BarChart3} accent={spreadPercent != null && spreadPercent > 1 ? 'gold' : 'green'} /></div>
            <div className="mt-4 space-y-2">{routeRows.slice(0, 5).map((route, index) => <div key={`${route.vendor}-${index}`} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5"><div className="min-w-0"><div className="truncate text-xs font-bold text-white">{route.vendor}</div><div className="text-[9px] text-slate-600">{route.mode} · impact {route.impact == null ? '—' : `${route.impact}%`}</div></div><div className="text-right"><div className="font-mono text-xs font-bold text-white">{money(route.sharePrice, 4)}</div><div className={`text-[9px] ${route.gap == null ? 'text-slate-600' : route.gap > 0 ? 'text-[#00FFB2]' : 'text-[#FFC700]'}`}>{route.gap == null ? 'No reference' : `${route.gap >= 0 ? '+' : ''}${route.gap.toFixed(3)}%`}</div></div></div>)}</div>
            <p className="mt-3 text-[9px] leading-relaxed text-slate-600">Routes are informational until independently re-quoted and simulated in the execution panel.</p>
          </>}
        </GlassPanel>
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(330px,.8fr)]">
        <GlassPanel>
          <div className="mb-5 flex items-center justify-between gap-3"><div><div className="flex items-center gap-2"><Gauge className="size-4 text-[#00B7FF]" /><h2 className="text-xs font-black uppercase tracking-[0.15em] text-white">Realized candle volatility</h2></div><div className="mt-1 text-[10px] text-slate-500">{currentAsset?.ticker} · {timeframe} interval · actual close series</div></div><Badge tone="cyan">{chartCandles.length} candles</Badge></div>
          {realizedVolatility == null ? <EmptyData title="Volatility unavailable" body="At least three valid candle observations are required. No volatility estimate is inferred from a single price." /> : <div className="grid gap-5 sm:grid-cols-[.75fr_1.25fr] sm:items-center"><div><div className="text-4xl font-black tracking-tight text-white">{realizedVolatility.toFixed(4)}%</div><div className="mt-1 text-[10px] uppercase tracking-[0.13em] text-slate-500">Std dev of log returns</div><p className="mt-4 text-[10px] leading-relaxed text-slate-600">Descriptive sample volatility for the selected candle window. Not annualized, not a forecast, and not a risk guarantee.</p></div><div className="flex h-28 items-end gap-1 rounded-xl border border-white/[0.06] bg-black/25 px-3 py-3">{chartCandles.slice(-32).map((candle, index, visible) => { const min = Math.min(...visible.map((point) => point.value)); const max = Math.max(...visible.map((point) => point.value)); const range = Math.max(max - min, Math.abs(max) * 0.001, 0.000001); const height = 16 + ((candle.value - min) / range) * 70; return <div key={`${candle.timestamp}-${index}`} title={`${candle.time}: ${money(candle.value, 4)}`} className="flex-1 rounded-t-sm bg-gradient-to-t from-[#00B7FF]/15 to-[#00B7FF]/75" style={{ height: `${height}px` }} />; })}</div></div>}
        </GlassPanel>

        <GlassPanel>
          <div className="mb-5 flex items-center justify-between gap-3"><div><div className="flex items-center gap-2"><CircleDot className="size-4 text-[#FFC700]" /><h2 className="text-xs font-black uppercase tracking-[0.15em] text-white">Session gap matrix</h2></div><div className="mt-1 text-[10px] text-slate-500">Live classifications supplied by the asset feed</div></div><button type="button" onClick={onSelectMarkets} className="control-focus text-[9px] font-bold text-[#00B7FF] hover:text-white">Directory <ArrowRight className="ml-1 inline size-3" /></button></div>
          <div className="space-y-3">{[
            ['Open / trading', sessionCounts.open, '#00FFB2'],
            ['Closed / post-market', sessionCounts.closed, '#FFC700'],
            ['Paused / halted', sessionCounts.paused, '#fb7185'],
            ['Status unavailable', sessionCounts.unknown, '#00B7FF'],
          ].map(([label, count, color]) => <div key={label} className="flex items-center gap-3"><div className="w-32 shrink-0 text-[10px] text-slate-500">{label}</div><div className="h-2 flex-1 overflow-hidden rounded-full bg-white/[0.05]"><div className="h-full rounded-full" style={{ width: `${assets.length ? (Number(count) / assets.length) * 100 : 0}%`, backgroundColor: color }} /></div><div className="w-10 text-right font-mono text-[10px] font-bold text-slate-300">{Number(count).toLocaleString()}</div></div>)}</div>
          <div className="mt-5 border-t border-white/[0.06] pt-4"><div className="mb-3 text-[9px] font-bold uppercase tracking-[0.14em] text-slate-600">24h volume leaders · source feed</div>{volumeDistribution.length ? <div className="space-y-2">{volumeDistribution.slice(0, 5).map((asset) => <div key={asset.address} className="flex items-center gap-3"><span className="w-14 truncate text-[10px] font-bold text-slate-300">{asset.ticker}</span><div className="h-1.5 flex-1 rounded-full bg-white/[0.05]"><div className="h-full rounded-full bg-[#00B7FF]" style={{ width: `${Math.max(2, (asset.volume24H / maxVolume) * 100)}%` }} /></div><span className="w-16 text-right font-mono text-[9px] text-slate-500">{compactMoney(asset.volume24H)}</span></div>)}</div> : <div className="text-[10px] text-slate-600">No volume values in the current response.</div>}</div>
        </GlassPanel>
      </section>
    </div>
  );
}
