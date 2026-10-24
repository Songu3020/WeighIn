import * as path from "path";
import { ZodError } from "zod";
import type { FixturesSpec, ContractSpec, InvocationSpec } from "./measurement";
import { FixturesSpecSchema, formatZodError } from "./config";

export interface IdentifiedInvocation extends InvocationSpec {
  case_id: string;
}

export interface IdentifiedContract extends ContractSpec {
  logical_id: string;
  invocations: IdentifiedInvocation[];
}

export interface IdentifiedFixtures extends FixturesSpec {
  fixture_id: string;
  contracts: IdentifiedContract[];
}

function relativePath(value: string): string {
  const portable = value.replace(/\\/g, "/");
  if (path.posix.isAbsolute(portable) || /^[A-Za-z]:/.test(portable)) {
    throw new Error(
      `Comparison identity requires a relative path or an explicit id: ${value}`,
    );
  }
  return path.posix.normalize(portable);
}

// Argument object key order is irrelevant; argument array order is significant.
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

/** Resolve logical identities before any deployment or simulation side effects.
 * fixturePath is a stable workspace-relative path, shared by BASE and HEAD.
 * Explicit ids are scoped to their fixture/contract, not global names.
 */
export function parseFixtures(
  raw: string,
  fixturePath: string,
): IdentifiedFixtures {
  let fixtures: ReturnType<typeof FixturesSpecSchema.parse>;
  try {
    fixtures = FixturesSpecSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(formatZodError(err, fixturePath));
    }
    throw err;
  }
  const fixture_id =
    fixtures.id === undefined
      ? `path:${relativePath(fixturePath)}`
      : `id:${fixtures.id}`;
  const contractIds = new Set<string>();
  const contracts = fixtures.contracts.map((contract) => {
    const logical_id =
      contract.id === undefined
        ? `wasm:${relativePath(contract.wasm_path)}`
        : `id:${contract.id}`;
    if (contractIds.has(logical_id)) {
      throw new Error(
        `Duplicate logical contract identity in ${fixture_id}: ${logical_id}`,
      );
    }
    contractIds.add(logical_id);

    const caseIds = new Set<string>();
    const invocations = contract.invocations.map((invocation) => {
      const args = invocation.args.map((arg) => ({
        type: arg.type.toLowerCase(),
        value: canonical(arg.value),
      }));
      const case_id =
        invocation.id === undefined
          ? `args:${JSON.stringify(args)}`
          : `id:${invocation.id}`;
      const key = JSON.stringify([invocation.function_name, case_id]);
      if (caseIds.has(key)) {
        throw new Error(
          `Duplicate benchmark identity in ${logical_id}: ${invocation.function_name} / ${case_id}. Set distinct invocation ids.`,
        );
      }
      caseIds.add(key);
      return { ...invocation, case_id };
    });
    return { ...contract, logical_id, invocations };
  });
  return { ...fixtures, fixture_id, contracts };
}
