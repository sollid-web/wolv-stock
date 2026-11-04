import AgentControlPlane from "@/components/AgentControlPlane";
import AgentPolicyPanel from "@/components/AgentPolicyPanel";
import GlobalNav from "@/components/GlobalNav";

export default function AgentPage() {
  return (
    <>
      <AgentPolicyPanel />
      <AgentControlPlane />
      <GlobalNav />
    </>
  );
}
