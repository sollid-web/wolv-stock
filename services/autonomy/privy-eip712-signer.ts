import { createPrivateKey } from "node:crypto";
import { recoverTypedDataAddress } from "viem";

export interface Eip712Field {
  name: string;
  type: string;
}

export interface Eip712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Eip712Field[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

export type Eip712FieldKind = "address" | "uint" | "string" | "bytes32";

export interface ExpectedEip712Field {
  role: string;
  path: string;
  value: string;
  kind: Eip712FieldKind;
}

export interface PrivyEip712Policy {
  vendor: string;
  chainId: 56;
  verifyingContracts: string[];
  primaryType: string;
  expectedTypes: Record<string, Eip712Field[]>;
  expectedDomain?: Record<string, string>;
  expectedFields: ExpectedEip712Field[];
  requiredRoles: string[];
}


export type Eip712PolicyValueSource =
  | "walletAddress"
  | "inputTokenAddress"
  | "outputTokenAddress"
  | "amountIn"
  | "expectedAmountOut"
  | "minimumAmountOut"
  | "quoteExpiryUnixSeconds"
  | "quoteId"
  | "orderId"
  | "vendor";

export interface Eip712FieldBinding {
  role: string;
  path: string;
  kind: Eip712FieldKind;
  source: Eip712PolicyValueSource | "typedDataField";
  sourcePath?: string;
  allowedValues?: string[];
}

export interface PrivyEip712PolicyTemplate {
  vendor: string;
  chainId: 56;
  verifyingContracts: string[];
  primaryType: string;
  expectedTypes: Record<string, Eip712Field[]>;
  expectedDomain: Record<string, string>;
  fieldBindings: Eip712FieldBinding[];
  requiredRoles: string[];
}

export function bindPrivyEip712Policy(
  template: PrivyEip712PolicyTemplate,
  values: Record<Eip712PolicyValueSource, string>,
  typedDataMessage?: Record<string, unknown>,
): PrivyEip712Policy {
  if (!template.vendor || !template.primaryType || template.chainId !== 56) {
    throw new Error("Privy EIP-712 policy template has invalid vendor, primary type or chain");
  }
  if (!template.verifyingContracts.length || !template.fieldBindings.length || !template.requiredRoles.length) {
    throw new Error("Privy EIP-712 policy template is incomplete");
  }
  const expectedFields = template.fieldBindings.map((binding) => {
    let value: string;
    if (binding.source === "typedDataField") {
      if (!typedDataMessage || !binding.sourcePath) {
        throw new Error("Typed-data field binding requires a sourcePath and parsed provider message");
      }
      const raw = readPath(typedDataMessage, binding.sourcePath);
      if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "bigint") {
        throw new Error("Typed-data source field is not a scalar value: " + binding.role);
      }
      value = String(raw);
    } else {
      value = values[binding.source];
      if (!value) throw new Error("Missing dynamic EIP-712 policy value for role: " + binding.role);
    }
    if (binding.allowedValues?.length && !binding.allowedValues.some((allowed) => allowed.toLowerCase() === value.toLowerCase())) {
      throw new Error("Typed-data field value is not allowlisted for role: " + binding.role);
    }
    return {
      role: binding.role,
      path: binding.path,
      kind: binding.kind,
      value,
    };
  });
  return {
    vendor: template.vendor,
    chainId: template.chainId,
    verifyingContracts: template.verifyingContracts,
    primaryType: template.primaryType,
    expectedTypes: template.expectedTypes,
    expectedDomain: template.expectedDomain,
    expectedFields,
    requiredRoles: template.requiredRoles,
  };
}

export interface PrivyEip712SignRequest {
  walletId: string;
  walletAddress: string;
  signerOperationId: string;
  providerVendor: string;
  typedData: unknown;
  policy: PrivyEip712Policy;
  beforeSign?: () => Promise<void>;
}

export interface PrivyEip712SigningClient {
  signTypedData(input: {
    walletId: string;
    walletAddress: string;
    typedData: Eip712TypedData;
    idempotencyKey: string;
  }): Promise<{ signature: string }>;
}

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const SIGNATURE_PATTERN = /^0x[0-9a-f]{130}$/i;
const BYTES32_PATTERN = /^0x[0-9a-f]{64}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseTypedData(value: unknown): Eip712TypedData {
  let parsed = value;
  if (typeof value === "string") {
    if (value.startsWith("0x")) {
      throw new Error("Opaque hex typed-data payloads are not eligible for unattended signing");
    }
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("Typed-data payload is not valid JSON");
    }
  }

  if (!isPlainObject(parsed) ||
      !isPlainObject(parsed.domain) ||
      !isPlainObject(parsed.types) ||
      !isPlainObject(parsed.message) ||
      typeof parsed.primaryType !== "string" ||
      !parsed.primaryType) {
    throw new Error("Malformed EIP-712 typed-data payload");
  }

  for (const [typeName, fields] of Object.entries(parsed.types)) {
    if (!Array.isArray(fields) || !fields.every((field) =>
      isPlainObject(field) &&
      typeof field.name === "string" &&
      typeof field.type === "string"
    )) {
      throw new Error(`Malformed EIP-712 type definition: ${typeName}`);
    }
  }

  return parsed as unknown as Eip712TypedData;
}


function validateMessageShape(
  typedData: Eip712TypedData,
  typeName: string,
  value: unknown,
  path: string,
): void {
  const fields = typedData.types[typeName];
  if (!fields || !isPlainObject(value)) {
    throw new Error(`EIP-712 nested struct is malformed: ${path}`);
  }

  const expectedNames = fields.map((field) => field.name).sort();
  const actualNames = Object.keys(value).sort();
  if (expectedNames.join("|") !== actualNames.join("|")) {
    throw new Error(`EIP-712 message fields differ from the declared type: ${path}`);
  }

  for (const field of fields) {
    const child = value[field.name];
    const arrayMatch = field.type.match(/^(.*)\[[0-9]*\]$/);
    if (arrayMatch) {
      throw new Error(`EIP-712 array fields are not enabled for unattended signing: ${path}.${field.name}`);
    }
    if (typedData.types[field.type] && field.type !== "EIP712Domain") {
      validateMessageShape(typedData, field.type, child, `${path}.${field.name}`);
    }
  }
}

function collectMessageLeafPaths(
  types: Record<string, Eip712Field[]>,
  typeName: string,
  prefix = "",
  ancestors: string[] = [],
): string[] {
  if (ancestors.includes(typeName)) throw new Error("Recursive EIP-712 structs are not supported");
  const fields = types[typeName];
  if (!fields) throw new Error("EIP-712 type definition is missing: " + typeName);
  const paths: string[] = [];
  for (const field of fields) {
    const path = prefix ? prefix + "." + field.name : field.name;
    if (/\[[0-9]*\]$/.test(field.type)) {
      throw new Error("EIP-712 array fields are not enabled for unattended signing: " + path);
    }
    if (types[field.type] && field.type !== "EIP712Domain") {
      paths.push(...collectMessageLeafPaths(types, field.type, path, [...ancestors, typeName]));
    } else {
      paths.push(path);
    }
  }
  return paths;
}

function declaredFieldType(
  types: Record<string, Eip712Field[]>,
  primaryType: string,
  path: string,
): string {
  const parts = path.split(".");
  let currentType = primaryType;
  for (let index = 0; index < parts.length; index += 1) {
    const field = types[currentType]?.find((candidate) => candidate.name === parts[index]);
    if (!field) throw new Error("EIP-712 policy path is not in the declared schema: " + path);
    if (index === parts.length - 1) return field.type;
    if (!types[field.type]) throw new Error("EIP-712 policy path traverses a non-struct field: " + path);
    currentType = field.type;
  }
  throw new Error("Invalid EIP-712 policy field path");
}

function fieldKindMatchesType(kind: Eip712FieldKind, type: string): boolean {
  if (kind === "address") return type === "address";
  if (kind === "uint") return /^uint([0-9]+)?$/.test(type);
  if (kind === "string") return type === "string";
  if (kind === "bytes32") return type === "bytes32";
  return false;
}

function readPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  if (!path || parts.some((part) => !part || part === "__proto__" || part === "constructor" || part === "prototype")) {
    throw new Error("Invalid EIP-712 message field path");
  }

  let value: unknown = root;
  for (const part of parts) {
    if (!isPlainObject(value) || !(part in value)) {
      throw new Error(`Required EIP-712 message field is missing: ${path}`);
    }
    value = value[part];
  }
  return value;
}

function normalizeExpected(kind: Eip712FieldKind, value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new Error("EIP-712 policy values must be scalar strings or integers");
  }
  const raw = String(value);

  if (kind === "address") {
    if (!ADDRESS_PATTERN.test(raw)) throw new Error("Invalid expected EIP-712 address");
    return raw.toLowerCase();
  }
  if (kind === "uint") {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("Invalid expected EIP-712 uint");
    return BigInt(raw).toString();
  }
  if (kind === "bytes32") {
    if (!BYTES32_PATTERN.test(raw)) throw new Error("Invalid expected EIP-712 bytes32");
    return raw.toLowerCase();
  }
  return raw;
}

function normalizeActual(kind: Eip712FieldKind, value: unknown): string {
  if (kind === "address") {
    if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
      throw new Error("EIP-712 message address field is malformed");
    }
    return value.toLowerCase();
  }
  if (kind === "uint") {
    if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") ||
        (typeof value === "number" && !Number.isSafeInteger(value))) {
      throw new Error("EIP-712 message uint field is malformed");
    }
    const raw = String(value);
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error("EIP-712 message uint field is malformed");
    return BigInt(raw).toString();
  }
  if (kind === "bytes32") {
    if (typeof value !== "string" || !BYTES32_PATTERN.test(value)) {
      throw new Error("EIP-712 message bytes32 field is malformed");
    }
    return value.toLowerCase();
  }
  if (typeof value !== "string") throw new Error("EIP-712 message string field is malformed");
  return value;
}

export function validatePrivyEip712Request(request: PrivyEip712SignRequest): Eip712TypedData {
  if (!request.walletId || request.walletId.length > 256) throw new Error("Privy wallet ID is required");
  if (!ADDRESS_PATTERN.test(request.walletAddress)) throw new Error("Invalid wallet address");
  if (!request.signerOperationId || request.signerOperationId.length < 8 || request.signerOperationId.length > 128) {
    throw new Error("A durable signer operation ID is required");
  }

  if (!request.providerVendor || request.providerVendor !== request.policy.vendor) {
    throw new Error("RFQ vendor does not match the approved EIP-712 policy");
  }

  const typedData = parseTypedData(request.typedData);
  const chainId = typedData.domain.chainId;
  if ((typeof chainId !== "string" && typeof chainId !== "number") ||
      String(chainId) !== String(request.policy.chainId)) {
    throw new Error("EIP-712 signing domain is not BNB Smart Chain (chain ID 56)");
  }

  const verifyingContract = typedData.domain.verifyingContract;
  if (typeof verifyingContract !== "string" ||
      !ADDRESS_PATTERN.test(verifyingContract) ||
      !request.policy.verifyingContracts.some((address) =>
        ADDRESS_PATTERN.test(address) && address.toLowerCase() === verifyingContract.toLowerCase()
      )) {
    throw new Error("EIP-712 verifying contract is not allowlisted");
  }

  if (typedData.primaryType !== request.policy.primaryType ||
      !Object.prototype.hasOwnProperty.call(typedData.types, typedData.primaryType)) {
    throw new Error("EIP-712 primary type is not allowlisted");
  }

  if (canonicalize(typedData.types) !== canonicalize(request.policy.expectedTypes)) {
    throw new Error("EIP-712 type schema differs from the approved RFQ schema");
  }

  const expectedDomain = request.policy.expectedDomain ?? {};
  const expectedDomainKeys = new Set(["chainId", "verifyingContract", ...Object.keys(expectedDomain)]);
  const actualDomainKeys = Object.keys(typedData.domain).sort();
  if (actualDomainKeys.join("|") !== [...expectedDomainKeys].sort().join("|")) {
    throw new Error("EIP-712 domain contains missing or unapproved fields");
  }
  for (const [key, expectedValue] of Object.entries(expectedDomain)) {
    if (String(typedData.domain[key]) !== expectedValue) {
      throw new Error(`EIP-712 domain field does not match policy: ${key}`);
    }
  }

  validateMessageShape(typedData, typedData.primaryType, typedData.message, typedData.primaryType);

  const requiredCoreRoles = ["wallet", "tokenIn", "tokenOut", "amountIn", "minimumOutput", "expiry"];
  if (!request.policy.expectedFields.length || !request.policy.requiredRoles.length ||
      requiredCoreRoles.some((role) => !request.policy.requiredRoles.includes(role))) {
    throw new Error("Explicit EIP-712 message bindings and all critical signing roles are mandatory");
  }

  const seenRoles = new Set<string>();
  for (const field of request.policy.expectedFields) {
    if (!field.role || seenRoles.has(field.role)) {
      throw new Error("EIP-712 policy roles must be present and unique");
    }
    seenRoles.add(field.role);
  }
  for (const role of request.policy.requiredRoles) {
    if (!seenRoles.has(role)) throw new Error(`Required EIP-712 policy role is missing: ${role}`);
  }

  const declaredLeafPaths = collectMessageLeafPaths(typedData.types, typedData.primaryType).sort();
  const configuredPaths = request.policy.expectedFields.map((field) => field.path).sort();
  if (declaredLeafPaths.join("|") !== configuredPaths.join("|")) {
    throw new Error("Every EIP-712 message field must have an explicit execution-policy binding");
  }

  const seenPaths = new Set<string>();
  for (const field of request.policy.expectedFields) {
    if (seenPaths.has(field.path)) throw new Error(`Duplicate EIP-712 policy field: ${field.path}`);
    seenPaths.add(field.path);
    if (!["address", "uint", "string", "bytes32"].includes(field.kind)) {
      throw new Error(`Unsupported EIP-712 policy field kind: ${field.kind}`);
    }
    const declaredType = declaredFieldType(typedData.types, typedData.primaryType, field.path);
    if (!fieldKindMatchesType(field.kind, declaredType)) {
      throw new Error(`EIP-712 policy kind does not match declared type for ${field.path}`);
    }
    const actual = readPath(typedData.message, field.path);
    const expected = normalizeExpected(field.kind, field.value);
    if (normalizeActual(field.kind, actual) !== expected) {
      throw new Error(`EIP-712 message field does not match the execution intent: ${field.path}`);
    }
  }

  return typedData;
}

export function createPrivyEip712Signer(client: PrivyEip712SigningClient) {
  return {
    async sign(request: PrivyEip712SignRequest): Promise<string> {
      const typedData = validatePrivyEip712Request(request);
      await request.beforeSign?.();
      const result = await client.signTypedData({
        walletId: request.walletId,
        walletAddress: request.walletAddress,
        typedData,
        idempotencyKey: request.signerOperationId,
      });

      if (!result || typeof result.signature !== "string" || !SIGNATURE_PATTERN.test(result.signature)) {
        throw new Error("Privy returned a malformed EIP-712 signature");
      }

      const recoveryTypes = { ...typedData.types };
      delete recoveryTypes.EIP712Domain;
      const recoveryInput = {
        domain: { ...typedData.domain, chainId: 56 },
        types: recoveryTypes,
        primaryType: typedData.primaryType,
        message: typedData.message,
        signature: result.signature as `0x${string}`,
      } as unknown as Parameters<typeof recoverTypedDataAddress>[0];
      const recoveredAddress = await recoverTypedDataAddress(recoveryInput);
      if (recoveredAddress.toLowerCase() !== request.walletAddress.toLowerCase()) {
        throw new Error("Privy signature recovered to a different wallet than the quote-bound signer");
      }
      return result.signature;
    },
  };
}


/**
 * Structural surface of the official @privy-io/node 0.39.x public API.
 * Keep the adapter dependency-injected so tests can exercise the exact request
 * without requiring Privy credentials or making network calls.
 */
export interface PrivyNodeEthereumWalletService {
  signTypedData(
    walletId: string,
    input: {
      caip2: "eip155:56";
      params: {
        typed_data: {
          domain: Record<string, unknown>;
          message: Record<string, unknown>;
          primary_type: string;
          types: Record<string, Eip712Field[]>;
        };
      };
      authorization_context: { authorization_private_keys: string[] };
      idempotency_key: string;
    },
  ): Promise<{ encoding: "hex"; signature: string }>;
}

export interface PrivyNodeWalletsService {
  ethereum(): PrivyNodeEthereumWalletService;
}

export interface PrivyNodeClientLike {
  wallets(): PrivyNodeWalletsService;
}

function normalizeAuthorizationPrivateKey(value: string): string {
  try {
    const key = value.includes("BEGIN PRIVATE KEY")
      ? createPrivateKey(value)
      : createPrivateKey({
          key: Buffer.from(value, "base64"),
          format: "der",
          type: "pkcs8",
        });
    if (key.asymmetricKeyType !== "ec" ||
        key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("wrong key type");
    }
    return key.export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    throw new Error("Privy authorization key must be a valid PKCS8 P-256 private key in PEM or base64 DER form");
  }
}

export function createPrivyNodeEip712SigningClient(input: {
  client: PrivyNodeClientLike;
  authorizationPrivateKey: string;
}): PrivyEip712SigningClient {
  const authorizationPrivateKey = normalizeAuthorizationPrivateKey(input.authorizationPrivateKey);

  return {
    async signTypedData(request) {
      const response = await input.client.wallets().ethereum().signTypedData(request.walletId, {
        caip2: "eip155:56",
        params: {
          typed_data: {
            domain: request.typedData.domain,
            message: request.typedData.message,
            primary_type: request.typedData.primaryType,
            types: request.typedData.types,
          },
        },
        authorization_context: {
          authorization_private_keys: [authorizationPrivateKey],
        },
        idempotency_key: request.idempotencyKey,
      });

      if (!response ||
          typeof response.signature !== "string" || !SIGNATURE_PATTERN.test(response.signature)) {
        throw new Error("Privy Node SDK returned a malformed EIP-712 signature response");
      }
      return { signature: response.signature };
    },
  };
}

export function createPrivyNodeEip712Signer(input: {
  client: PrivyNodeClientLike;
  authorizationPrivateKey: string;
}) {
  return createPrivyEip712Signer(createPrivyNodeEip712SigningClient(input));
}
