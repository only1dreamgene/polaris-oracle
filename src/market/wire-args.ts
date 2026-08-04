import { contract as StellarContract } from '@stellar/stellar-sdk';

/**
 * JSON-transportable argument values from an HTTP request body: plain
 * numbers don't survive i128/u64 precision, and Buffers don't survive JSON
 * at all, so the wire convention is decimal-string for big integers,
 * hex-string for bytes, and plain strings for everything else (addresses,
 * the `Prediction` enum tag).
 */
export type WireArgs = Record<string, string | number>;

/**
 * Converts wire-format args into whatever `contract.Spec.funcArgsToScVals`
 * expects, by reflecting on the target function's own parameter types —
 * rather than hardcoding a conversion table per function — so this stays
 * correct if the contract's function signatures change.
 */
export function coerceWireArgs(
  spec: StellarContract.Spec,
  functionName: string,
  wireArgs: WireArgs,
): Record<string, unknown> {
  const func = spec.getFunc(functionName);
  const out: Record<string, unknown> = {};

  for (const input of func.inputs()) {
    const name = input.name().toString();
    if (!(name in wireArgs)) {
      continue;
    }
    const raw = wireArgs[name];
    const typeName = input.type().switch().name as string;

    switch (typeName) {
      case 'scSpecTypeI128':
      case 'scSpecTypeU128':
      case 'scSpecTypeI64':
      case 'scSpecTypeU64':
        out[name] = BigInt(raw as string);
        break;
      case 'scSpecTypeBytes':
        out[name] = Buffer.from(raw as string, 'hex');
        break;
      case 'scSpecTypeBytesN':
        out[name] = Buffer.from(raw as string, 'hex');
        break;
      case 'scSpecTypeUdt': {
        const udtName = input.type().udt().name().toString();
        if (udtName === 'Prediction') {
          out[name] = { tag: raw as string, values: undefined };
        } else {
          out[name] = raw;
        }
        break;
      }
      default:
        out[name] = raw;
    }
  }

  return out;
}
