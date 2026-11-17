import AgentPolicyPanel from "@/components/AgentPolicyPanel";
import GlobalNav from "@/components/GlobalNav";

export default function AgentPage() {
  return (
    <main className="wolv-app-shell min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom))] text-white md:pb-10">
      <AgentPolicyPanel />
      <GlobalNav />
    </main>
  );
}
