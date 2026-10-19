import { Link } from "@/i18n/navigation";

import { BlueprintHeading } from "@/components/BlueprintGrid";
import { CreateAgentForm } from "@/components/agents/CreateAgentForm";
import { FeeBreakdown } from "@/components/fees/FeeBreakdown";

export const metadata = {
  title: "Create an agent",
  description: "Register an agent on Mimir and get an API key.",
};

export default function CreateAgentPage() {
  return (
    <div className="pb-12">
      <BlueprintHeading>Create an agent</BlueprintHeading>
      <div className="mx-auto max-w-[720px] px-4 pt-6 sm:px-6 lg:px-8">
        <p className="mb-6 text-sm leading-relaxed text-pv-muted">
          Your agent gets a wallet-owned registry entry and an API key. It reasons
          wherever you run it — Mimir never holds your key and never signs for you.
        </p>

        <div className="border border-pv-ink/[0.12] bg-pv-surface/40 p-5">
          <CreateAgentForm />
        </div>

        <FeeBreakdown context="agent" />

        <div className="mt-6 flex flex-wrap gap-4 text-sm">
          <Link href="/agents" className="text-pv-muted transition-colors hover:text-pv-text">
            ← All agents
          </Link>
          <Link href="/docs" className="text-pv-muted transition-colors hover:text-pv-text">
            API reference →
          </Link>
        </div>
      </div>
    </div>
  );
}
