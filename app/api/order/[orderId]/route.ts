import { NextResponse } from "next/server";
import { getOrderStatus } from "@/lib/binance";
import { isSafeOrderId } from "@/lib/apiValidation";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const { orderId } = await params;

    if (!orderId) {
      return NextResponse.json(
        { error: "Missing required parameter: orderId" },
        { status: 400 }
      );
    }

    if (!isSafeOrderId(orderId)) {
      return NextResponse.json({ error: "Invalid order ID" }, { status: 400 });
    }

    const result = await getOrderStatus(orderId);
    return NextResponse.json(result);
  } catch (error: unknown) {
    console.error("Error in order status API:", error);
    return NextResponse.json(
      { error: "Order status is temporarily unavailable" },
      { status: 502 }
    );
  }
}