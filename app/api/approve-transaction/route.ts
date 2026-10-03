import { NextResponse } from "next/server";
import { getApproveTransaction } from "@/lib/binance";
import { BSC_USDT_ADDRESS, EVM_ADDRESS_PATTERN, isPositiveUint256 } from "@/lib/apiValidation";
import { isSpotRwaTokenAddress } from "@/lib/spotAssets";
import { verifyQuoteBinding } from "@/lib/quoteBinding";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const tokenContractAddress = searchParams.get("tokenContractAddress");
    const toToken = searchParams.get("toToken");
    const approveAmount = searchParams.get("approveAmount");
    const userWalletAddress = searchParams.get("userWalletAddress");
    const vendor = searchParams.get("vendor");
    const quoteId = searchParams.get("quoteId");
    const quoteBinding = searchParams.get("quoteBinding");

    if (!tokenContractAddress || !toToken || !approveAmount || !userWalletAddress || !quoteId || !quoteBinding) {
      return NextResponse.json(
        { error: "Missing required parameters: tokenContractAddress, approveAmount, userWalletAddress, quoteId, quoteBinding" },
        { status: 400 }
      );
    }

    if (tokenContractAddress.toLowerCase() !== BSC_USDT_ADDRESS.toLowerCase() || !EVM_ADDRESS_PATTERN.test(toToken) || !EVM_ADDRESS_PATTERN.test(userWalletAddress) || !isPositiveUint256(approveAmount) || !/^[a-zA-Z0-9_-]{1,128}$/.test(quoteId)) {
      return NextResponse.json({ error: "Invalid approval token, target asset, wallet, or amount" }, { status: 400 });
    }

    const binding = verifyQuoteBinding(quoteBinding, { toToken, amount: approveAmount, wallet: userWalletAddress, quoteId });
    if (!binding.ok || !binding.approveTarget) {
      return NextResponse.json({ error: binding.ok ? "Quote is missing a validated approval spender" : binding.reason }, { status: 409 });
    }

    if (!await isSpotRwaTokenAddress(toToken)) {
      return NextResponse.json({ error: "Approvals are limited to supported spot tokenized assets" }, { status: 400 });
    }

    if (vendor && (vendor.length > 128 || /[\r\n]/.test(vendor))) {
      return NextResponse.json({ error: "Invalid vendor" }, { status: 400 });
    }

    // Validate that userWalletAddress is not the dead address for trading
    const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
    if (userWalletAddress?.toLowerCase() === DEAD_ADDRESS.toLowerCase()) {
      return NextResponse.json(
        { error: "Cannot use dead address for real trading" },
        { status: 400 }
      );
    }

    const result = await getApproveTransaction(
      tokenContractAddress,
      approveAmount,
      userWalletAddress,
      vendor === null ? undefined : vendor // Convert null to undefined for optional param
    );
    const resultData = (result as { data?: unknown }).data;
    const approvalTransaction = Array.isArray(resultData) ? resultData[0] : resultData;
    const spender = approvalTransaction && typeof approvalTransaction === "object" && "dexContractAddress" in approvalTransaction
      ? (approvalTransaction as { dexContractAddress?: unknown }).dexContractAddress
      : undefined;
    if (typeof spender !== "string" || !EVM_ADDRESS_PATTERN.test(spender) || spender.toLowerCase() !== binding.approveTarget.toLowerCase()) {
      return NextResponse.json({ error: "Approval spender does not match the quoted Binance route" }, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Error in approve-transaction API:", error);
    return NextResponse.json(
      { error: "Approval service is temporarily unavailable" },
      { status: 502 }
    );
  }
}
