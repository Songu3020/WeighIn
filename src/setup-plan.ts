import { xdr } from "@stellar/stellar-sdk";
import type { IdentifiedContract } from "./identity";
import type { BindingSelectorStep, SetupBinding } from "./measurement";

/** Committed outcome of one deployment in a revision/scenario setup plan. */
export interface SetupResult {
  logical_id: string;
  contract_id: string;
  /** "created" when this run committed the instance, "existing_instance" when
   *  the instance ledger entry was already present and verified. */
  source: "created" | "existing_instance";
  /** Base64 ScVal XDR returned by the committed create transaction, or the
   *  verified instance address for an existing instance. */
  return_xdr?: string;
}

// ScVal arms accepted for each declared fixture argument type. No coercion.
const SCVAL_ARM: Record<string, string> = {
  address: "scvAddress",
  bool: "scvBool",
  string: "scvString",
  symbol: "scvSymbol",
  u32: "scvU32",
  i32: "scvI32",
  u64: "scvU64",
  i64: "scvI64",
  u128: "scvU128",
  i128: "scvI128",
  bytes: "scvBytes",
  vec: "scvVec",
  map: "scvMap",
};

/** Validate dependency references and bindings, and return the contracts in
 *  deterministic topological order. Ties keep fixture declaration order, so a
 *  fixture without dependencies deploys exactly as declared. Every rejection
 *  happens before any account, RPC or deployment side effect.
 */
export function planSetupOrder(
  fixtureId: string,
  contracts: IdentifiedContract[],
): IdentifiedContract[] {
  const fail = (message: string): never => {
    throw new Error(`Invalid setup plan in ${fixtureId}: ${message}`);
  };
  const byId = new Map<string, IdentifiedContract>();
  for (const contract of contracts) {
    if (contract.id !== undefined) byId.set(contract.id, contract);
  }

  const dependencies = new Map<IdentifiedContract, IdentifiedContract[]>();
  for (const contract of contracts) {
    const declared = contract.depends_on ?? [];
    const seen = new Set<string>();
    const resolved = declared.map((id) => {
      if (seen.has(id))
        fail(`${contract.logical_id} lists dependency "${id}" more than once`);
      seen.add(id);
      if (id === contract.id)
        fail(`${contract.logical_id} cannot depend on itself`);
      const dependency = byId.get(id);
      if (!dependency)
        fail(
          `${contract.logical_id} depends on unknown contract id "${id}"; dependencies must name another contract's explicit id`,
        );
      return dependency!;
    });
    dependencies.set(contract, resolved);

    for (const invocation of contract.invocations) {
      invocation.args.forEach((arg, index) => {
        if (!("binding" in arg)) return;
        if (!seen.has(arg.binding.contract))
          fail(
            `${contract.logical_id} / ${invocation.case_id} argument ${index} binds "${arg.binding.contract}", which is not a declared dependency of this contract`,
          );
      });
    }
  }

  // Kahn's algorithm, always taking the earliest declared ready contract.
  const order: IdentifiedContract[] = [];
  const placed = new Set<IdentifiedContract>();
  while (order.length < contracts.length) {
    const next = contracts.find(
      (contract) =>
        !placed.has(contract) &&
        dependencies.get(contract)!.every((dep) => placed.has(dep)),
    );
    if (!next) {
      const cycle = contracts
        .filter((contract) => !placed.has(contract))
        .map((contract) => contract.logical_id);
      fail(`dependency cycle among ${cycle.join(", ")}`);
    }
    placed.add(next!);
    order.push(next!);
  }
  return order;
}

/** Every contract that transitively depends on the failed one, in plan order. */
export function dependentsOf(
  failed: IdentifiedContract,
  order: IdentifiedContract[],
): IdentifiedContract[] {
  const aborted = new Set<string>([failed.logical_id]);
  const result: IdentifiedContract[] = [];
  const byId = new Map(
    order
      .filter((contract) => contract.id !== undefined)
      .map((contract) => [contract.id!, contract.logical_id]),
  );
  for (const contract of order) {
    const blocked = (contract.depends_on ?? []).some((id) =>
      aborted.has(byId.get(id)!),
    );
    if (blocked && !aborted.has(contract.logical_id)) {
      aborted.add(contract.logical_id);
      result.push(contract);
    }
  }
  return result;
}

function describePath(select: BindingSelectorStep[], upTo: number): string {
  return (
    "$" +
    select
      .slice(0, upTo)
      .map((step) => ("index" in step ? `[${step.index}]` : `.${step.field}`))
      .join("")
  );
}

/** Resolve a typed binding against a committed setup return. The selected
 *  ScVal is passed through unchanged; a missing return, malformed XDR, a path
 *  that does not exist, or a type mismatch fails explicitly.
 */
export function resolveBinding(
  binding: SetupBinding,
  declaredType: string,
  result: SetupResult | undefined,
): xdr.ScVal {
  const label = `binding to "${binding.contract}"`;
  if (!result) {
    throw new Error(
      `Cannot resolve ${label}: the dependency has no committed setup result`,
    );
  }
  if (result.return_xdr === undefined) {
    throw new Error(
      `Cannot resolve ${label}: the committed setup of ${result.logical_id} returned no value`,
    );
  }
  let value: xdr.ScVal;
  try {
    value = xdr.ScVal.fromXDR(result.return_xdr, "base64");
  } catch (error: any) {
    throw new Error(
      `Cannot resolve ${label}: the setup return of ${result.logical_id} is not valid ScVal XDR (${error.message})`,
    );
  }

  const select = binding.select ?? [];
  select.forEach((step, position) => {
    const at = describePath(select, position);
    const arm = value.switch().name;
    if ("index" in step) {
      if (arm !== "scvVec" || !value.vec()) {
        throw new Error(
          `Cannot resolve ${label}: ${at} is ${arm}, not a vec, so index ${step.index} cannot be selected`,
        );
      }
      const items = value.vec()!;
      if (step.index >= items.length) {
        throw new Error(
          `Cannot resolve ${label}: index ${step.index} is out of range at ${at} (length ${items.length})`,
        );
      }
      value = items[step.index];
      return;
    }
    if (arm !== "scvMap" || !value.map()) {
      throw new Error(
        `Cannot resolve ${label}: ${at} is ${arm}, not a map, so field "${step.field}" cannot be selected`,
      );
    }
    const entry = value.map()!.find((candidate) => {
      const key = candidate.key();
      const keyArm = key.switch().name;
      return (
        (keyArm === "scvSymbol" || keyArm === "scvString") &&
        (keyArm === "scvSymbol" ? key.sym() : key.str()).toString() ===
          step.field
      );
    });
    if (!entry) {
      throw new Error(
        `Cannot resolve ${label}: field "${step.field}" does not exist at ${at}`,
      );
    }
    value = entry.val();
  });

  const expected = SCVAL_ARM[declaredType];
  const actual = value.switch().name;
  if (actual !== expected) {
    throw new Error(
      `Cannot resolve ${label}: ${describePath(select, select.length)} is ${actual}, but the argument declares ${declaredType}`,
    );
  }
  return value;
}
