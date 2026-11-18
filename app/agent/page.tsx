import AgentPolicyPanel from "@/components/AgentPolicyPanel";
import GlobalNav from "@/components/GlobalNav";
import SiteHeader from "@/components/SiteHeader";

export default function AgentPage() {
  return (
    <main className="wolv-app-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <SiteHeader networkLabel={Number(process.env.NEXT_PUBLIC_CHAIN_ID) === 97 ? "BNB Chain · Testnet" : "BNB Chain · Mainnet"} />
      <AgentPolicyPanel />
      <GlobalNav />
    </main>
  );
}
