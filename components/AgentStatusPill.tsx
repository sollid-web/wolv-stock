"use client";

import Link from "next/link";
import { STATE_STYLE, useAgentStatus } from "@/components/useAgentStatus";

/** Compact live agent state for the site header; reflects persisted state only. */
export default function AgentStatusPill() {
  const { status } = useAgentStatus();
  if (!status) return null;
  const style = STATE_STYLE[status.state] ?? STATE_STYLE.OFFLINE;
  return (
    <Link
      href="/agent"
      title={`${status.headline}. ${status.detail}`}
      className={`hidden items-center gap-2 rounded-full border px-3 py-2 text-[10px] font-bold transition hover:brightness-125 xl:flex ${style.ring} ${style.text}`}
    >
      <span className="relative flex size-1.5">
        {style.live && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${style.dot}`} />}
        <span className={`relative inline-flex size-1.5 rounded-full ${style.dot}`} />
      </span>
      Agent · {style.label}
    </Link>
  );
}
