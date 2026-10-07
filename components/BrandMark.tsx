import Link from "next/link";

export default function BrandMark({ compact = false, linked = true }: { compact?: boolean; linked?: boolean }) {
  const content = (
    <>
      <span className="wolv-brand-mark" aria-hidden="true">W</span>
      {!compact && <span className="text-sm font-black tracking-[0.2em] text-white">WOLV</span>}
    </>
  );

  if (!linked) {
    return <span className="flex shrink-0 items-center gap-2.5" aria-label="WOLV">{content}</span>;
  }

  return <Link href="/" aria-label="WOLV home" className="flex shrink-0 items-center gap-2.5">{content}</Link>;
}
