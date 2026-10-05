import OpportunityMonitor from "@/components/OpportunityMonitor";

export const dynamic = "force-dynamic";

export default function Home({ searchParams }: { searchParams: Promise<{ n?: string }> }) {
  return <OpportunityMonitor searchParams={searchParams} />;
}
