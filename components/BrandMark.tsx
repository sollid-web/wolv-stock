import Link from "next/link";

export default function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" aria-label="WOLV home" className="flex shrink-0 items-center gap-2.5">
      <span className="wolv-brand-mark" aria-hidden="true">W</span>
      {!compact && <span className="text-sm font-black tracking-[0.2em] text-white">WOLV</span>}
    </Link>
  );
}
