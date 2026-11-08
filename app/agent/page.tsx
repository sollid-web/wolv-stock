import AgentPolicyPanel from "@/components/AgentPolicyPanel";
import GlobalNav from "@/components/GlobalNav";
import Web3StrategyShowcase from "@/components/Web3StrategyShowcase";

export default function AgentPage() {
  return (
    <main className="wolv-app-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <AgentPolicyPanel />
      <Web3StrategyShowcase />
      <GlobalNav />
    </main>
  );
}
