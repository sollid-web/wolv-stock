export default function HackathonAccessNotice() {
  return (
    <aside className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-xs leading-5 text-amber-100/80">
      <p>
        The hackathon and Binance Web3 developer product are unavailable to people located in, resident or citizen of the United States, Canada, the Netherlands, Iran, Cuba, North Korea, Crimea, Donetsk, Luhansk, the United Kingdom, or Japan, and to sanctioned persons.
      </p>
      <a
        href="https://web3.binance.com/en/dev-docs/web3-api-prohibited-regions"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-block font-semibold text-amber-200 underline"
      >
        Check the official prohibited-region list
      </a>
      <p className="mt-1 text-amber-100/60">This notice is informational; the app does not geofence or determine eligibility.</p>
    </aside>
  );
}