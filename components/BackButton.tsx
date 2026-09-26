"use client";
import { useRouter } from "next/navigation";

export default function BackButton() {
  const router = useRouter();
  return (
    <button
      onClick={() => router.back()}
      className="text-[#64748b] text-xl cursor-pointer"
    >
      ←
    </button>
  );
}
