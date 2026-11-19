const ROLES = [
  {
    title: "Owner wallet",
    tag: "You",
    body: "Installs the policy hook, sets the limits, signs the one-time agent permission, and can stop or revoke at any time. Never shared with the agent.",
  },
  {
    title: "Agent signer",
    tag: "Delegated key",
    body: "Signs bounded trade intents only. It cannot change the policy, move funds elsewhere, or exceed the owner's caps and expiry.",
  },
  {
    title: "On-chain policy hook",
    tag: "Enforced by BNB Chain",
    body: "Re-checks every trade: approved router and token, per-trade and rolling caps, Chainlink price floor, slippage, expiry, and actual token delivery.",
  },
];

/** Explains the separation between owner authorization, agent signing and on-chain enforcement. */
export default function AgentRolesExplainer() {
  return (
    <section aria-labelledby="agent-roles-title" className="mt-5">
      <h2 id="agent-roles-title" className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Who controls what</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {ROLES.map((role) => (
          <article key={role.title} className="wolv-glass rounded-xl p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-black text-white">{role.title}</h3>
              <span className="rounded-full border border-[#d9a80a]/30 bg-[#d9a80a]/[0.07] px-2 py-0.5 text-[10px] font-bold text-[#f2c94c]">{role.tag}</span>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-400">{role.body}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
