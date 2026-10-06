'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { 
  ComposedChart, 
  Area, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';
import { 
  Zap, 
  TrendingUp, 
  Sparkles, 
  AlertTriangle, 
  Cpu, 
  CheckCircle2, 
  ChevronRight, 
  RefreshCw, 
  Wallet
} from 'lucide-react';

const INITIAL_STOCK_DATA = {
  SPY: {
    ticker: 'SPY',
    name: 'SPDR S&P 500 ETF Trust',
    issuer: 'Ondo / Bstock',
    referencePrice: 575.31,
    executablePrice: 575.96,
    gap: 0.082,
    freshness: '2s old',
    status: 'Overnight vs Open',
    isMismatch: true,
    volume24h: '$1.42B',
    chartData: [
      { time: '09:30', price: 572.10, volume: 1200 },
      { time: '10:30', price: 573.40, volume: 2100 },
      { time: '11:30', price: 572.80, volume: 1800 },
      { time: '12:30', price: 574.15, volume: 2900 },
      { time: '13:30', price: 573.90, volume: 1500 },
      { time: '14:30', price: 575.20, volume: 3400 },
      { time: '15:30', price: 575.96, volume: 4800 },
    ],
    venues: [
      { name: 'Ondo (PcsX)', price: 576.05, mode: 'RFQ', impact: '0.041%', status: 'Overnight', age: '2s' },
      { name: 'Bstock (LiquidMesh)', price: 575.42, mode: 'SWAP', impact: '0.001%', status: 'Open', age: '1s' }
    ]
  },
  SPCX: {
    ticker: 'SPCX',
    name: 'SpaceX Pre-IPO Token',
    issuer: 'Bstock Alpha',
    referencePrice: 171.69,
    executablePrice: 172.85,
    gap: 0.675,
    freshness: '1s old',
    status: 'TRADING',
    isMismatch: false,
    volume24h: '$48.5M',
    chartData: [
      { time: '02:00', price: 158.31, volume: 400 },
      { time: '06:00', price: 161.20, volume: 850 },
      { time: '10:00', price: 165.40, volume: 1900 },
      { time: '14:00', price: 169.80, volume: 3100 },
      { time: '18:00', price: 171.69, volume: 2400 },
      { time: '22:00', price: 172.85, volume: 4200 },
    ],
    venues: [
      { name: 'Bstock (LiquidMesh)', price: 172.85, mode: 'SWAP', impact: '0.012%', status: 'TRADING', age: '1s' },
      { name: 'Ondo Secondary', price: 174.10, mode: 'RFQ', impact: '0.080%', status: 'Offhours', age: '5s' }
    ]
  },
  NVDA: {
    ticker: 'NVDAon',
    name: 'NVIDIA Corp On-Chain',
    issuer: 'Bstock / Ondo',
    referencePrice: 135.20,
    executablePrice: 135.45,
    gap: 0.185,
    freshness: '3s old',
    status: 'TRADING',
    isMismatch: false,
    volume24h: '$890M',
    chartData: [
      { time: '09:00', price: 128.40, volume: 3000 },
      { time: '11:00', price: 131.20, volume: 4500 },
      { time: '13:00', price: 130.80, volume: 2100 },
      { time: '15:00', price: 134.10, volume: 5200 },
      { time: '17:00', price: 135.45, volume: 6100 },
    ],
    venues: [
      { name: 'Bstock (LiquidMesh)', price: 135.45, mode: 'SWAP', impact: '0.002%', status: 'TRADING', age: '3s' },
      { name: 'Ondo (PcsX)', price: 135.90, mode: 'RFQ', impact: '0.025%', status: 'TRADING', age: '2s' }
    ]
  }
};

const GlassCard = ({ children, className = '' }) => (
  <div className={`bg-[#0A0D14]/70 backdrop-blur-2xl border border-white/10 rounded-2xl p-5 relative overflow-hidden shadow-[0_20px_50px_rgba(0,0,0,0.6)] hover:border-[#FFC700]/40 hover:shadow-[0_0_35px_rgba(255,199,0,0.12)] transition-all duration-300 ${className}`}>
    {/* Top light reflection border */}
    <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent pointer-events-none" />
    {children}
  </div>
);

const GlassBadge = ({ children, variant = 'gold', pulse = false }) => {
  const styles = {
    gold: 'bg-[#FFC700]/10 border-[#FFC700]/30 text-[#FFC700]',
    green: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
    blue: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400',
    red: 'bg-rose-500/10 border-rose-500/30 text-rose-400'
  };

  return (
    <span className={`inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${styles[variant]}`}>
      {pulse && (
        <span className="relative flex h-2 w-2">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${variant === 'gold' ? 'bg-[#FFC700]' : 'bg-emerald-400'}`} />
          <span className={`relative inline-flex rounded-full h-2 w-2 ${variant === 'gold' ? 'bg-[#FFC700]' : 'bg-emerald-400'}`} />
        </span>
      )}
      <span>{children}</span>
    </span>
  );
};

const RouteFlowDiagram = ({ activeTicker, selectedMode }) => (
  <div className="p-4 rounded-xl bg-black/40 border border-white/5 relative overflow-hidden">
    <div className="text-xs font-bold uppercase tracking-wider text-white/50 mb-3 flex items-center justify-between">
      <span className="flex items-center space-x-2">
        <Cpu className="w-3.5 h-3.5 text-[#FFC700]" />
        <span>On-Chain Execution Route</span>
      </span>
      <span className="text-[10px] font-mono text-white/40">Target: 0xb444...dda5</span>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-center relative z-10">
      {/* Node 1 */}
      <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3 text-center">
        <div className="text-[10px] text-white/40 uppercase font-mono mb-1">Input Token</div>
        <div className="text-sm font-bold text-white flex items-center justify-center space-x-1">
          <Wallet className="w-3.5 h-3.5 text-[#FFC700]" />
          <span>USDT (BSC)</span>
        </div>
        <div className="text-[10px] text-emerald-400 mt-1 font-mono">$100.00 Spot</div>
      </div>

      {/* Dynamic Connector 1 */}
      <div className="hidden md:flex flex-col items-center justify-center">
        <div className="text-[10px] font-mono text-[#FFC700] mb-1">Selector 0xad43f73d</div>
        <svg className="w-full h-6" viewBox="0 0 100 24">
          <path d="M 0 12 L 100 12" stroke="rgba(255, 199, 0, 0.3)" strokeWidth="2" fill="none" />
          <path d="M 0 12 L 100 12" stroke="#FFC700" strokeWidth="2" fill="none" className="animate-flow" />
        </svg>
      </div>

      {/* Node 2 */}
      <div className="bg-[#FFC700]/10 border border-[#FFC700]/30 rounded-lg p-3 text-center shadow-[0_0_20px_rgba(255,199,0,0.15)]">
        <div className="text-[10px] text-[#FFC700] uppercase font-bold tracking-wider mb-1">WOLV Router</div>
        <div className="text-xs font-mono font-bold text-white">Binance Aggregator</div>
        <div className="text-[9px] text-white/60 font-mono mt-0.5">Slippage Protection</div>
      </div>

      {/* Dynamic Connector 2 */}
      <div className="hidden md:flex flex-col items-center justify-center">
        <div className="text-[10px] font-mono text-cyan-400 mb-1">
          {selectedMode === 'SWAP' ? 'LiquidMesh (SWAP)' : 'PcsX (RFQ)'}
        </div>
        <svg className="w-full h-6" viewBox="0 0 100 24">
          <path d="M 0 12 L 100 12" stroke="rgba(0, 183, 255, 0.3)" strokeWidth="2" fill="none" />
          <path d="M 0 12 L 100 12" stroke="#00B7FF" strokeWidth="2" fill="none" className="animate-flow" />
        </svg>
      </div>

      {/* Node 3 */}
      <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3 text-center">
        <div className="text-[10px] text-white/40 uppercase font-mono mb-1">Output Asset</div>
        <div className="text-sm font-bold text-white flex items-center justify-center space-x-1">
          <span className="w-2 h-2 rounded-full bg-[#FFC700]" />
          <span>{activeTicker} Token</span>
        </div>
        <div className="text-[10px] text-cyan-400 mt-1 font-mono">Instant Settlement</div>
      </div>
    </div>
  </div>
);

export default function WolvTerminal() {
  const [selectedTicker, setSelectedTicker] = useState('SPY');
  const [timeframe, setTimeframe] = useState('1D');
  const [isLiveStreaming, setIsLiveStreaming] = useState(true);
  const [stockState, setStockState] = useState(INITIAL_STOCK_DATA);
  const [mounted, setMounted] = useState(false);

  // Next.js hydration safety check for Recharts
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Recharts must render only after mount to avoid SSR hydration mismatches.
    setMounted(true);
  }, []);

  const activeStock = useMemo(() => stockState[selectedTicker], [stockState, selectedTicker]);

  useEffect(() => {
    if (!isLiveStreaming) return;

    const interval = setInterval(() => {
      setStockState((prev) => {
        const current = prev[selectedTicker];
        const randomDelta = (Math.random() - 0.48) * 0.4;
        const newExecPrice = Number((current.executablePrice + randomDelta).toFixed(2));
        
        const updatedChart = [...current.chartData];
        const lastIdx = updatedChart.length - 1;
        updatedChart[lastIdx] = { ...updatedChart[lastIdx], price: newExecPrice };

        return {
          ...prev,
          [selectedTicker]: {
            ...current,
            executablePrice: newExecPrice,
            chartData: updatedChart
          }
        };
      });
    }, 2500);

    return () => clearInterval(interval);
  }, [isLiveStreaming, selectedTicker]);

  return (
    <div className="relative overflow-x-hidden rounded-3xl border border-white/10 bg-[#05070B] text-white font-sans antialiased selection:bg-[#FFC700]/30 shadow-2xl">
      
      {/* Background Glows */}
      <div className="absolute top-[-10%] left-[-5%] w-[600px] h-[600px] bg-[#FFC700]/10 rounded-full blur-[160px] pointer-events-none animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-5%] w-[700px] h-[700px] bg-[#FFC700]/5 rounded-full blur-[180px] pointer-events-none" />

      {/* Top Running Marquee Header */}
      <div className="w-full bg-black/60 border-b border-white/5 backdrop-blur-md overflow-hidden py-2 text-xs font-mono relative z-20">
        <div className="animate-marquee whitespace-nowrap flex space-x-8 items-center">
          {Object.entries(stockState).concat(Object.entries(stockState)).map(([tickerKey, item], idx) => (
            <button key={`${tickerKey}-${idx}`} type="button" className="inline-flex items-center space-x-3 cursor-pointer text-left" onClick={() => setSelectedTicker(tickerKey)}>
              <span className="font-bold text-white/90">{item.ticker}</span>
              <span className="text-white/50">${item.executablePrice.toFixed(2)}</span>
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${item.gap >= 0 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>
                Gap {item.gap > 0 ? '+' : ''}{item.gap}%
              </span>
              <span className="text-white/20">|</span>
            </button>
          ))}
        </div>
      </div>

      {/* Header */}
      <header className="relative z-20 bg-[#070A10]/80 backdrop-blur-xl border-b border-white/5 px-4 lg:px-8 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-[#FFC700] p-0.5 shadow-[0_0_20px_rgba(255,199,0,0.3)]">
              <div className="w-full h-full bg-[#070A10] rounded-[10px] flex items-center justify-center font-black text-xl text-[#FFC700]">
                W
              </div>
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-black text-lg tracking-wider text-white">WOLV</span>
                <span className="text-[10px] font-bold bg-[#FFC700]/20 text-[#FFC700] border border-[#FFC700]/30 px-1.5 py-0.5 rounded uppercase">Next.js RWA Lens</span>
              </div>
              <p className="text-[10px] text-white/40 font-mono">Illustrative demo • not live market data</p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <button 
              onClick={() => setIsLiveStreaming(!isLiveStreaming)}
              className={`hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-mono border transition-all ${
                isLiveStreaming 
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' 
                  : 'bg-white/5 border-white/10 text-white/40'
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${isLiveStreaming ? 'animate-spin' : ''}`} />
              <span>{isLiveStreaming ? 'DEMO RUNNING' : 'DEMO PAUSED'}</span>
            </button>

            <button type="button" disabled title="Wallet connection is not wired up in this demo" className="bg-[#FFC700] text-black font-bold text-xs px-5 py-2.5 rounded-xl shadow-[0_0_25px_rgba(255,199,0,0.3)] opacity-70 cursor-not-allowed transition-all flex items-center space-x-2">
              <Wallet className="w-4 h-4" />
              <span>Connect Wallet</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="max-w-7xl mx-auto px-4 lg:px-8 py-6 space-y-6 relative z-10">

        <p className="rounded-xl border border-[#FFC700]/30 bg-[#FFC700]/10 px-4 py-3 text-xs leading-relaxed text-[#FFC700]">
          Demo only: all displayed prices, venue quotes, freshness labels, and simulated updates are illustrative and are not live or executable market data.
        </p>
        
        {/* Ticker Selector Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-3 overflow-x-auto pb-2 md:pb-0">
            {Object.keys(stockState).map((ticker) => {
              const isSelected = selectedTicker === ticker;
              const stock = stockState[ticker];
              return (
                <button
                  key={ticker}
                  onClick={() => setSelectedTicker(ticker)}
                  className={`bg-[#0A0D14]/70 border p-3 rounded-xl flex items-center space-x-3 min-w-[160px] text-left transition-all ${
                    isSelected ? 'border-[#FFC700] bg-[#FFC700]/10 shadow-[0_0_25px_rgba(255,199,0,0.15)]' : 'border-white/10 opacity-70 hover:opacity-100'
                  }`}
                >
                  <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center font-bold text-xs text-[#FFC700]">
                    {ticker.substring(0, 3)}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-white">{stock.ticker}</div>
                    <div className="text-sm font-mono font-extrabold text-white/90">${stock.executablePrice.toFixed(2)}</div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex items-center space-x-2 self-end">
            <GlassBadge variant={activeStock.isMismatch ? 'gold' : 'green'} pulse={true}>
              {activeStock.status}
            </GlassBadge>
            <GlassBadge variant="blue">
              Quote Freshness: {activeStock.freshness}
            </GlassBadge>
          </div>
        </div>

        {/* Dynamic Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Main Glass Chart Panel */}
          <GlassCard className="lg:col-span-2 space-y-6">
            
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <div className="flex items-center space-x-2">
                  <h1 className="text-2xl font-black text-white tracking-tight">{activeStock.ticker}</h1>
                  <span className="text-xs text-white/40 font-medium">• {activeStock.name}</span>
                </div>
                
                <div className="flex items-baseline space-x-4 mt-1">
                  <span className="text-4xl font-extrabold text-white tracking-tight font-mono">
                    ${activeStock.executablePrice.toFixed(2)}
                  </span>
                  <span className="text-emerald-400 text-sm font-bold flex items-center">
                    <TrendingUp className="w-4 h-4 mr-1" />
                    +{activeStock.gap}% Spread Gap
                  </span>
                </div>
              </div>

              {/* Timeframe Controls */}
              <div className="flex bg-black/50 p-1 rounded-xl border border-white/10 self-start">
                {['1H', '1D', '1W', '1M', 'ALL'].map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setTimeframe(tf)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      timeframe === tf 
                        ? 'bg-white/15 text-[#FFC700] shadow-sm' 
                        : 'text-white/40 hover:text-white'
                    }`}
                  >
                    {tf}
                  </button>
                ))}
              </div>
            </div>

            {/* Recharts Canvas with Next.js Hydration Check */}
            <div className="h-[320px] w-full relative pt-4">
              {mounted ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={activeStock.chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="goldGlow" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#FFC700" stopOpacity={0.45} />
                        <stop offset="50%" stopColor="#FFC700" stopOpacity={0.10} />
                        <stop offset="100%" stopColor="#FFC700" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="volumeBarGlow" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#ffffff" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#ffffff" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>

                    <XAxis 
                      dataKey="time" 
                      stroke="rgba(255,255,255,0.15)" 
                      tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis 
                      yAxisId="price"
                      domain={['dataMin - 2', 'dataMax + 2']} 
                      stroke="none"
                      tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11, fontFamily: 'monospace' }}
                      tickFormatter={(val) => `$${val}`}
                    />
                    <YAxis yAxisId="volume" domain={[0, 'dataMax * 3']} hide />

                    <Tooltip 
                      content={({ active, payload, label }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className="bg-[#090D14]/90 backdrop-blur-md border border-[#FFC700]/30 p-3 rounded-xl shadow-2xl font-mono text-xs">
                              <div className="text-white/50 mb-1">{label}</div>
                              <div className="text-[#FFC700] font-bold text-base">
                                ${payload[0]?.value?.toFixed(2)}
                              </div>
                              <div className="text-white/40 mt-0.5">
                                Vol: {payload[1]?.value?.toLocaleString()}
                              </div>
                            </div>
                          );
                        }
                        return null;
                      }}
                      cursor={{ stroke: 'rgba(255, 199, 0, 0.3)', strokeWidth: 1, strokeDasharray: '4 4' }}
                    />

                    <Bar yAxisId="volume" dataKey="volume" fill="url(#volumeBarGlow)" radius={[3, 3, 0, 0]} maxBarSize={30} />
                    
                    <Area
                      yAxisId="price"
                      type="monotone"
                      dataKey="price"
                      stroke="#FFC700"
                      strokeWidth={3}
                      fill="url(#goldGlow)"
                      dot={false}
                      activeDot={{ 
                        r: 6, 
                        fill: "#05070B", 
                        stroke: "#FFC700", 
                        strokeWidth: 3,
                        style: { filter: 'drop-shadow(0px 0px 12px #FFC700)' }
                      }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs font-mono text-white/30">
                  Loading Market Stream...
                </div>
              )}
            </div>

            {/* Execution Route Flow Diagram */}
            <RouteFlowDiagram activeTicker={activeStock.ticker} selectedMode={activeStock.venues[0]?.mode || 'SWAP'} />

          </GlassCard>

          {/* Right Column */}
          <div className="space-y-6">
            
            {/* WOLV AI Live Analyzer Card */}
            <GlassCard>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-2">
                  <div className="relative flex items-center justify-center w-7 h-7 rounded-lg bg-[#FFC700]/20 border border-[#FFC700]/40 text-[#FFC700]">
                    <Sparkles className="w-4 h-4" />
                    <div className="absolute inset-0 rounded-lg border border-[#FFC700] animate-radar opacity-40" />
                  </div>
                  <div>
                    <h3 className="text-xs font-black uppercase tracking-wider text-white">WOLV AI Analyzer</h3>
                    <p className="text-[10px] text-white/40 font-mono">Real-time Risk Guard</p>
                  </div>
                </div>
                <GlassBadge variant="gold" pulse={true}>LIVE MONITOR</GlassBadge>
              </div>

              <div className="p-3.5 rounded-xl bg-white/[0.03] border border-white/10 space-y-2 text-xs leading-relaxed">
                {activeStock.isMismatch ? (
                  <>
                    <div className="flex items-start space-x-2 text-[#FFC700] font-bold">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Session Mismatch Detected</span>
                    </div>
                    <p className="text-white/70 text-[11px]">
                      {activeStock.ticker} shows an overnight status on Ondo vs. Open status on Bstock. The spread (+{activeStock.gap}%) reflects venue operating hours rather than an arbitrage opportunity.
                    </p>
                  </>
                ) : (
                  <>
                    <div className="flex items-start space-x-2 text-emerald-400 font-bold">
                      <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Optimal Execution Alignment</span>
                    </div>
                    <p className="text-white/70 text-[11px]">
                      Cross-venue quotes for {activeStock.ticker} are aligned with uniform TRADING session codes. Liquidity mesh is ready for sub-second BSC execution.
                    </p>
                  </>
                )}
              </div>
            </GlassCard>

            {/* Executable Venues List */}
            <GlassCard>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-xs font-bold uppercase tracking-wider text-white/70">Executable Venues</h3>
                <span className="text-[10px] font-mono text-white/40">100 USDT Quote Size</span>
              </div>

              <div className="space-y-3">
                {activeStock.venues.map((venue, idx) => (
                  <div key={idx} className="p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:border-white/20 transition-all flex items-center justify-between">
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold text-white">{venue.name}</span>
                        <span className={`text-[9px] font-mono font-bold px-1.5 py-0.2 rounded ${venue.mode === 'SWAP' ? 'bg-cyan-500/20 text-cyan-300' : 'bg-purple-500/20 text-purple-300'}`}>
                          {venue.mode}
                        </span>
                      </div>
                      <div className="text-[10px] text-white/40 font-mono mt-1">
                        Impact: {venue.impact} • {venue.age}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-sm font-bold font-mono text-white">${venue.price.toFixed(2)}</div>
                      <span className="text-[10px] font-bold text-[#FFC700] flex items-center justify-end space-x-1 mt-0.5">
                        <span>Trade Route</span>
                        <ChevronRight className="w-3 h-3" />
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              <button type="button" disabled title="This illustrative route does not execute trades" className="w-full mt-5 py-3 rounded-xl font-extrabold text-sm bg-[#FFC700] text-black shadow-[0_0_25px_rgba(255,199,0,0.3)] opacity-70 cursor-not-allowed transition-all flex items-center justify-center space-x-2">
                <Zap className="w-4 h-4 fill-black" />
                <span>Demo Route Only — No Transaction</span>
              </button>
            </GlassCard>

          </div>

        </div>

      </main>

    </div>
  );
}
