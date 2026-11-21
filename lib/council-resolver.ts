/*
 * Server-side helpers for resolving on-chain addresses to council personas.
 *
 * Pages like /agents, /stats, /council, and /vs/[id] need to map a raw
 * address to a persona spec (emoji, displayName, accent colors) so the UI
 * can show e.g. "🌙 The Optimist" instead of "0x3e5e…ffac".
 *
 * Lookups are address-keyed and EXACT. A Stellar `G…' strkey is case-sensitive
 * base32, so the case-insensitive matching this used for EVM hex would fold a
 * valid address into one that matches nothing. The map is built once per process
 * from the COUNCIL_<SLUG>_PUBLIC env vars.
 */

import "server-only";
import {
  listCouncilPersonas,
  personaPublicEnv,
  type PersonaSpec,
} from "../agents/council/personas";
import { PHILOSOPHER_PERSONAS } from "../agents/council/philosophers";

/**
 * Every seat on the council: the ten classic frames plus the ten philosopher ones.
 *
 * listCouncilPersonas() returns only the classic set — the philosophers live in
 * their own module and were therefore invisible to every page that resolves an
 * address, even though the council worker has been running and staking them all
 * along. They share PersonaSpec, so nothing downstream has to know the difference.
 */
function allCouncilPersonas(): PersonaSpec[] {
  return [...listCouncilPersonas(), ...PHILOSOPHER_PERSONAS];
}

export type ActorKind =
  | { kind: "oracle"; address: string }
  | { kind: "market-creator"; address: string }
  | { kind: "council"; address: string; persona: PersonaSpec }
  | { kind: "human"; address: string };

let cachedPersonaByAddress: Map<string, PersonaSpec> | null = null;

function buildPersonaIndex(): Map<string, PersonaSpec> {
  const map = new Map<string, PersonaSpec>();
  for (const p of allCouncilPersonas()) {
    const addr = process.env[personaPublicEnv(p)]?.split(/\s+(#/)[0].trim();
    if (addr) map.set(addr, p);
  }
  return map;
}

export function getCouncilPersonaIndex(): Map<string, PersonaSpec> {
  if (!cachedPersonaByAddress) {
    cachedPersonaByAddress = buildPersonaIndex();
  }
  return cachedPersonaByAddress;
}

/**
 * Returns every persona whose wallet env vars are wired in the current
 * deploy. Used by /council to render persona cards even when a persona
 * has zero on-chain activity yet.
 */
export function getActiveCouncilPersonas(): Array<{
  persona: PersonaSpec;
  address: string;
}> {
  const out: Array<{ persona: PersonaSpec; address: string }> = [];
  for (const p of allCouncilPersonas()) {
    const addr = process.env[personaPublicEnv(p)]?.split(/\s+(#/)[0].trim();
    if (addr) out.push({ persona: p, address: addr });
  }
  return out;
}

export function getPersonaForAddress(address: string): PersonaSpec | null {
  if (!address) return null;
  return getCouncilPersonaIndex().get(address.trim()) ?? null;
}

/**
 * Which kind of actor an address belongs to.
 *
 * Every comparison is exact and the address is returned as given (trimmed, never
 * case-folded). The EVM version lowercased the input AND the returned address,
 * which on Stellar would both break every match and hand callers back a string
 * that is not a valid strkey — so a UI would render an address no explorer can
 * resolve.
 */
export function classifyActor(
  address: string,
  oracleAddress?: string,
  marketCreatorAddress?: string,
): ActorKind {
  const actor = (address ?? "").trim();
  if (oracleAddress && actor === oracleAddress.trim()) {
    return { kind: "oracle", address: actor };
  }
  if (marketCreatorAddress && actor === marketCreatorAddress.trim()) {
    return { kind: "market-creator", address: actor };
  }
  const persona = getCouncilPersonaIndex().get(actor);
  if (persona) {
    return { kind: "council", address: actor, persona };
  }
  return { kind: "human", address: actor };
}

/**
 * One-line label for the activity feed.
 *   - 🌙 Optimist     (council)
 *   - oracle           (oracle agent)
 *   - market-creator   (market creator agent)
 *   - 0xabcd…1234      (human)
 */
export function actorShortLabel(actor: ActorKind): string {
  switch (actor.kind) {
    case "oracle":         return "oracle";
    case "market-creator": return "market-creator";
    case "council":        return `${actor.persona.emoji} ${actor.persona.displayName}`;
    case "human":          return `${actor.address.slice(0, 6)}…${actor.address.slice(-4)}`;
  }
}
