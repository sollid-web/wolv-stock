"use client";

import { useEffect, useId, useMemo, useState } from "react";

const RFQ_TTL_MS = 30_000;
const RING_RADIUS = 27;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export type RfqTicketProps = {
  ticker?: string;
  vendor?: string | null;
  quoteFetchedAt?: number | null;
  expiresAt?: number | null;
  typedDataToSign?: unknown;
};

function displayTypedData(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value, null, 2) ?? null;
  } catch {
    return null;
  }
}

function formatRemaining(milliseconds: number): string {
  return `${Math.ceil(milliseconds / 1_000).toString().padStart(2, "0")}s`;
}

export default function RfqTicket({
  ticker = "NVDA",
  vendor,
  quoteFetchedAt = null,
  expiresAt = null,
  typedDataToSign,
}: RfqTicketProps) {
  const [now, setNow] = useState(() => Date.now());
  const gradientId = `rfq-countdown-gradient-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const rawTypedData = useMemo(() => displayTypedData(typedDataToSign), [typedDataToSign]);
  const validWindow = typeof quoteFetchedAt === "number" && Number.isSafeInteger(quoteFetchedAt) &&
    typeof expiresAt === "number" && Number.isSafeInteger(expiresAt) &&
    quoteFetchedAt <= now &&
    expiresAt > quoteFetchedAt && expiresAt - quoteFetchedAt <= RFQ_TTL_MS;
  const remaining = validWindow ? Math.max(0, expiresAt - now) : 0;
  const progress = validWindow ? Math.min(1, remaining / (expiresAt - quoteFetchedAt)) : 0;
  const expired = validWindow && remaining === 0;
  const ringOffset = RING_CIRCUMFERENCE * (1 - progress);

  useEffect(() => {
    if (!validWindow || expired) return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [validWindow, expired]);

  return (
    <article className="wolv-glass relative isolate overflow-hidden rounded-2xl p-5 shadow-[0_24px_70px_rgba(0,0,0,.32)] sm:p-6">
      <div aria-hidden="true" className="pointer-events-none absolute -left-20 -top-24 -z-10 size-60 rounded-full bg-sky-300/[0.07] blur-3xl" />
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#d9a80a]">Request for quote</p>
          <h2 className="mt-1 text-lg font-black tracking-tight text-white">RFQ execution ticket</h2>
          <p className="mt-1 text-xs text-slate-500">EIP-712 · BNB Smart Chain · 56</p>
        </div>
        <span className="rounded-lg border border-white/[0.09] bg-white/[0.035] px-2.5 py-1.5 font-mono text-xs font-bold tracking-wider text-white">
          {ticker}
        </span>
      </header>

      <div className="mt-5 grid gap-4 sm:grid-cols-[auto_1fr] sm:items-center">
        <div className="relative grid size-[88px] place-items-center rounded-full border border-white/[0.06] bg-black/20">
          <svg
            aria-label={validWindow ? `Quote expires in ${formatRemaining(remaining)}` : "Quote countdown unavailable"}
            className="-rotate-90"
            height="80"
            role="img"
            viewBox="0 0 64 64"
            width="80"
          >
            <defs>
              <linearGradient id={gradientId} x1="0%" x2="100%" y1="0%" y2="100%">
                <stop offset="0%" stopColor="#d9a80a" />
                <stop offset="100%" stopColor="#7dd3fc" />
              </linearGradient>
            </defs>
            <circle cx="32" cy="32" r={RING_RADIUS} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="2.5" />
            <circle
              cx="32"
              cy="32"
              fill="none"
              stroke={`url(#${gradientId})`}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={validWindow ? ringOffset : RING_CIRCUMFERENCE}
              strokeLinecap="round"
              strokeWidth="2.5"
              style={{ filter: "drop-shadow(0 0 4px rgba(125,211,252,.42))", transition: "stroke-dashoffset 180ms linear" }}
            />
          </svg>
          <span aria-hidden="true" className={`absolute font-mono text-sm font-black tabular-nums ${expired ? "text-rose-300" : "text-white"}`}>
            {validWindow ? (expired ? "00s" : formatRemaining(remaining)) : "--"}
          </span>
        </div>

        <div className="min-w-0 rounded-xl border border-white/[0.08] bg-white/[0.035] p-4 backdrop-blur-lg shadow-[inset_0_1px_0_rgba(255,255,255,.045)]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">Routing vendor</span>
            {vendor
              ? <span className="rounded-full border border-[#d9a80a]/20 bg-[#d9a80a]/[0.06] px-2.5 py-1 text-[9px] font-bold text-[#f2c94c]">{vendor}</span>
              : <span className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[9px] font-semibold text-slate-500">Awaiting quote</span>}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs font-bold text-white">
              {expired ? "Quote window expired" : validWindow ? "Time-sensitive quote" : "No active quote"}
            </p>
            <span className="rounded-md border border-white/[0.07] bg-black/20 px-2 py-1 font-mono text-[8px] font-bold uppercase tracking-wider text-slate-500">
              {validWindow ? `${Math.floor((expiresAt - quoteFetchedAt) / 1_000)}s TTL` : "30s max TTL"}
            </span>
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            {validWindow
              ? expired ? "Request a fresh quote before continuing." : "Review the quote and wallet details before signing."
              : "A 30-second window starts only when a validated quote timestamp is supplied."}
          </p>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-white/[0.08] bg-[#050711]/65">
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.07] px-3.5 py-2.5">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.14em] text-slate-400">Typed data to sign</p>
            <p className="mt-0.5 text-[9px] text-slate-600">Read-only · provider payload</p>
          </div>
          <span className="rounded-md border border-white/[0.08] px-2 py-1 text-[8px] font-bold uppercase tracking-wider text-slate-500">EIP-712</span>
        </div>
        <pre
          aria-label="Raw EIP-712 typed data payload"
          className="max-h-48 min-h-24 overflow-auto whitespace-pre-wrap break-all p-3.5 font-mono text-[9px] leading-[1.65] text-sky-100/75"
        >
          {rawTypedData ?? "No provider typed-data payload is available. Signing and submission stay disabled until the RFQ schema is verified."}
        </pre>
      </div>
      <p className="mt-3 text-[9px] leading-4 text-slate-500">
        This panel never signs or submits. Verify the full payload, signer, domain, and expiry in the connected wallet.
      </p>
    </article>
  );
}
