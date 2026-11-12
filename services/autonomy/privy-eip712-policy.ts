import {
  bindPrivyEip712Policy,
  type Eip712Field,
  type Eip712FieldBinding,
  type Eip712PolicyValueSource,
  type PrivyEip712Policy,
  type PrivyEip712PolicyTemplate,
} from "./privy-eip712-signer";
import type { ValidatedBinanceRfqOrder } from "./binance-rfq-order";

const SOURCES = new Set<Eip712PolicyValueSource>([
  "walletAddress",
  "inputTokenAddress",
  "outputTokenAddress",
  "amountIn",
  "expectedAmountOut",
  "minimumAmountOut",
  "quoteExpiryUnixSeconds",
  "quoteId",
  "orderId",
  "vendor",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Privy EIP-712 policy has invalid " + field);
  return value.trim();
}

export function parsePrivyEip712PolicyTemplate(value: unknown): PrivyEip712PolicyTemplate {
  if (!record(value) || value.chainId !== 56 ||
      !Array.isArray(value.verifyingContracts) ||
      value.verifyingContracts.length === 0 ||
      !record(value.expectedTypes) ||
      !record(value.expectedDomain) ||
      !Array.isArray(value.fieldBindings) ||
      !Array.isArray(value.requiredRoles)) {
    throw new Error("Privy EIP-712 policy template is malformed");
  }

  const verifyingContracts = value.verifyingContracts.map((contract) => {
    if (typeof contract !== "string" || !/^0x[0-9a-f]{40}$/i.test(contract)) {
      throw new Error("Privy EIP-712 policy contains an invalid verifying contract");
    }
    return contract.toLowerCase();
  });

  const expectedTypes: Record<string, Eip712Field[]> = {};
  for (const [typeName, rawFields] of Object.entries(value.expectedTypes)) {
    if (!typeName || !Array.isArray(rawFields) || !rawFields.every((field) =>
      record(field) && typeof field.name === "string" && typeof field.type === "string"
    )) {
      throw new Error("Privy EIP-712 policy contains a malformed type definition");
    }
    expectedTypes[typeName] = rawFields.map((field) => ({
      name: String((field as Record<string, unknown>).name),
      type: String((field as Record<string, unknown>).type),
    }));
  }

  const expectedDomain: Record<string, string> = {};
  for (const [key, domainValue] of Object.entries(value.expectedDomain)) {
    if (typeof domainValue !== "string") throw new Error("Privy EIP-712 domain values must be strings");
    expectedDomain[key] = domainValue;
  }

  const fieldBindings: Eip712FieldBinding[] = value.fieldBindings.map((raw) => {
    if (!record(raw) ||
        typeof raw.role !== "string" ||
        typeof raw.path !== "string" ||
        !["address", "uint", "string", "bytes32"].includes(String(raw.kind)) ||
        typeof raw.source !== "string" || !SOURCES.has(raw.source as Eip712PolicyValueSource)) {
      throw new Error("Privy EIP-712 policy contains a malformed field binding");
    }
    return {
      role: raw.role,
      path: raw.path,
      kind: raw.kind as Eip712FieldBinding["kind"],
      source: raw.source as Eip712PolicyValueSource,
    };
  });

  const requiredRoles = value.requiredRoles.map((role) => string(role, "required role"));
  const requiredCore = ["wallet", "tokenIn", "tokenOut", "amountIn", "minimumOutput", "expiry"];
  if (requiredCore.some((role) => !requiredRoles.includes(role))) {
    throw new Error("Privy EIP-712 policy must require wallet, token, amount, minimum-output and expiry bindings");
  }

  return {
    vendor: string(value.vendor, "vendor"),
    chainId: 56,
    verifyingContracts,
    primaryType: string(value.primaryType, "primaryType"),
    expectedTypes,
    expectedDomain,
    fieldBindings,
    requiredRoles,
  };
}

export function loadPrivyEip712PolicyTemplateFromEnv(
  env: Record<string, string | undefined> = process.env,
): PrivyEip712PolicyTemplate {
  const raw = env.WOLV_BINANCE_RFQ_EIP712_POLICY_JSON?.trim();
  if (!raw) throw new Error("WOLV_BINANCE_RFQ_EIP712_POLICY_JSON is required; capture and approve a real Binance RFQ schema first");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("WOLV_BINANCE_RFQ_EIP712_POLICY_JSON must be valid JSON");
  }
  return parsePrivyEip712PolicyTemplate(parsed);
}

export function bindPrivyEip712PolicyToOrder(input: {
  template: PrivyEip712PolicyTemplate;
  order: ValidatedBinanceRfqOrder;
  walletAddress: string;
  minimumAmountOut: string;
}): PrivyEip712Policy {
  if (input.template.vendor !== input.order.vendor) {
    throw new Error("RFQ order vendor does not match the configured EIP-712 signing policy");
  }
  if (input.order.typedDataFormat !== "JSON_TYPED_DATA") {
    throw new Error("Opaque RFQ typed-data payloads cannot be signed autonomously");
  }
  const expiry = Date.parse(input.order.quoteExpiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error("RFQ order expired before EIP-712 policy binding");
  }

  return bindPrivyEip712Policy(input.template, {
    walletAddress: input.walletAddress.toLowerCase(),
    inputTokenAddress: input.order.inputTokenAddress.toLowerCase(),
    outputTokenAddress: input.order.outputTokenAddress.toLowerCase(),
    amountIn: input.order.amountIn,
    expectedAmountOut: input.order.expectedAmountOut,
    minimumAmountOut: input.minimumAmountOut,
    quoteExpiryUnixSeconds: Math.floor(expiry / 1000).toString(),
    quoteId: input.order.quoteId,
    orderId: input.order.orderId,
    vendor: input.order.vendor,
  });
}
