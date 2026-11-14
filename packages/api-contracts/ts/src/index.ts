// @openquant/api-contracts: TypeScript bindings of the shared contracts (OQ-05 §7).
//
// Generated types and validators come from packages/api-contracts/schemas at build time. This module
// runs in Workers, Node and browsers: it imports no Node module.

export type { ContractName, ContractTypes } from '../dist/generated/contracts.ts';
export { contracts, DECIMAL_PATTERN, EXACT_MAX_LENGTH, EXACT_PATTERN } from '../dist/generated/contracts.ts';
export type * from '../dist/generated/types.ts';
export { CanonicalError, canonicalJson, digest, digestBytes, type Sha256Digest } from './canonical.ts';
export {
  ContractError,
  type ContractErrorKind,
  type ContractFailureCode,
  failureCode,
  type SchemaViolation,
} from './errors.ts';
export {
  type JsonObject,
  type JsonValue,
  MAX_NESTING,
  MAX_PAYLOAD_BYTES,
  parseStrictJson,
  StrictJsonError,
  type StrictJsonErrorKind,
} from './strict-json.ts';
export { type ContractResult, isContractName, parseContract, validateContract } from './validate.ts';
