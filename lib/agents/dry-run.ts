/*
 * Pre-flight for a funded agent action: would the policy allow it, does the agent
 * have the money, and what would it actually be paid?
 *
 * `allowanceAtomic` is a HISTORICAL NAME, kept because the response shape is a
 * public API surface. On the EVM chain it was the ERC-20 allowance the agent had
 * granted the market contract, and a stake could not land without one. Soroban has
 * no standing allowance on this path — `challenge_claim` carries auth for exactly
 * the staked amount — so the caller now passes the agent's spendable USDC BALANCE,
 * which is the constraint that actually decides whether the stake goes through.
 * The arithmetic is identical either way: "have >= need".
 *
 * Rounding rule (stake sizing): stake amounts are integer atomic USDC (7 decimals)
 * end to end. Any fractional-atomic remainder from a basis-point calculation is
 * truncated toward zero by `usdcToUnits`, never rounded up, so a stake can never
 * exceed the requested USDC amount. The applied rule and the remainder are surfaced
 * in the dry-run output under `sizing` so the rounding is auditable.
 */
import { splitFees, snapshotFeePolicy, type SettlementOutcome } from "@/lib/fees";
import { unitsToUsdc, usdcToUnits } from "@/lib/usdc";
import type { ActionVerdict } from "./registry";

/** Version of the stake-sizing rounding policy. Bump when the rule changes. */
export const STAKE_SIZING_POLICY_VERSION = "1";

export const STAKE_SIZING_ROUNDING = "truncate_toward_zero";

export function buildAgentDryRun(args: {
  principalUsdc: number;
  grossPayoutUsdc: number;
  outcome: SettlementOutcome;
  /** Spendable USDC in atomic units (7 decimals). See the module note on the name. */
  allowanceAtomic: bigint;
  requiredAtomic: bigint;
  platformFeeBps: number;
  agentOwnerFeeBps: number;
  platformRecipient: string;
  ownerRecipient: string;
  policy: ActionVerdict;
}) {
  const principalUnits = usdcToUnits(args.principalUsdc);
  const grossPayoutUnits = usdcToUnits(args.grossPayoutUsdc);
  const fees = splitFees({
    principalUnits,
    grossPayoutUnits,
    outcome: args.outcome,
    snapshot: snapshotFeePolicy({
      platformFeeBps: args.platformFeeBps,
      agentOwnerFeeBps: args.agentOwnerFeeBps,
      platformRecipient: args.platformRecipient,
      agentOwnerRecipient: args.ownerRecipient,
    }),
  });
  return {
    allowed: args.policy.allowed && args.allowanceAtomic >= args.requiredAtomic,
    policy: args.policy,
    allowance: {
      currentAtomic: args.allowanceAtomic.toString(),
      requiredAtomic: args.requiredAtomic.toString(),
      sufficient: args.allowanceAtomic >= args.requiredAtomic,
      /** What `currentAtomic` measures, so a caller is not misled by the key name. */
      source: "spendable_usdc_balance",
    },
    sizing: {
      policyVersion: STAKE_SIZING_POLICY_VERSION,
      rounding: STAKE_SIZING_ROUNDING,
      principalAtomic: principalUnits.toString(),
      grossPayoutAtomic: grossPayoutUnits.toString(),
      /** Remainder from the requested stake after atomic truncation (USDC input). */
      principalRemainderUsdc: args.principalUsdc - unitsToUsdc(principalUnits),
      grossPayoutRemainderUsdc: args.grossPayoutUsdc - unitsToUsdc(grossPayoutUnits),
    },
    payout: {
      principalUsdc: unitsToUsdc(fees.principalUnits),
      grossProfitUsdc: unitsToUsdc(fees.grossProfitUnits),
      platformFeeUsdc: unitsToUsdc(fees.platformFeeUnits),
      agentOwnerFeeUsdc: unitsToUsdc(fees.agentOwnerFeeUnits),
      totalReturnUsdc: unitsToUsdc(fees.payoutUnits),
    },
  };
}
