/**
 * Trusted per-target post-merge delivery checks (sentinel #337).
 *
 * Merge is not delivery: a target's deployment checks (a Cloudflare deploy, a
 * router deploy) run on the merge commit after the merge gate has already
 * passed, and they are deliberately not merge gates (owner directive
 * 2026-10-30 for Passport). `requiredForDelivery` names the checks, by exact
 * check-run name or commit-status context, that must complete green on the
 * merge commit before the source issue is closed and the record completes.
 *
 * This is a separate optional policy field with its own parser: it never
 * changes the repository configuration contract, the review gate or the merge
 * gate. Policy is host-authored code keyed by the exact repository identity;
 * issue text, the target tree and model output are never inputs. The default
 * is empty, which keeps the existing closure behaviour unchanged.
 */
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

/** One target's post-merge delivery-check policy. */
export interface TargetDeliveryCheckPolicyV1 {
  /** Check names required green on the merge commit; empty means none. */
  readonly requiredForDelivery: readonly string[];
}

/** No more delivery checks than this per target. */
export const MAX_DELIVERY_CHECKS = 16;
/** No delivery check name longer than this. */
export const MAX_DELIVERY_CHECK_NAME = 200;

const EMPTY: TargetDeliveryCheckPolicyV1 = Object.freeze({
  requiredForDelivery: Object.freeze([]) as readonly string[],
});

/**
 * Host-authored entries keyed by lowercase `owner/name`. An entry is added
 * only with the exact check name its merge commits report; a guessed name
 * would park every delivery at its deadline.
 */
const TRUSTED_DELIVERY_CHECKS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([]);

/**
 * Parse one `requiredForDelivery` value: an array of distinct, non-empty,
 * bounded check names. `undefined` is the default (empty). Anything else
 * throws, so a malformed entry never silently disables the gate.
 */
export function parseRequiredForDeliveryV1(
  input: unknown,
): readonly string[] {
  if (input === undefined) return EMPTY.requiredForDelivery;
  if (!Array.isArray(input) || input.length > MAX_DELIVERY_CHECKS) {
    throw new Error("requiredForDelivery must be a bounded array");
  }
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of input) {
    if (typeof item !== "string") {
      throw new Error("requiredForDelivery names must be strings");
    }
    const name = item.trim();
    if (
      name.length === 0 || name.length > MAX_DELIVERY_CHECK_NAME ||
      name !== item
    ) throw new Error("requiredForDelivery name is empty or unbounded");
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new Error("requiredForDelivery names must be distinct");
    }
    seen.add(key);
    names.push(name);
  }
  return Object.freeze(names);
}

/** The trusted delivery-check policy for one exact repository identity. */
export function targetDeliveryCheckPolicyV1(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  table: ReadonlyMap<string, readonly string[]> = TRUSTED_DELIVERY_CHECKS,
): TargetDeliveryCheckPolicyV1 {
  const entry = table.get(
    `${repository.owner.toLowerCase()}/${repository.name.toLowerCase()}`,
  );
  return entry === undefined
    ? EMPTY
    : { requiredForDelivery: parseRequiredForDeliveryV1([...entry]) };
}
