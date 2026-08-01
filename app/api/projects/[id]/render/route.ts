import { NextResponse } from "next/server";
import { renderMockPost } from "@/lib/mock-agents";

export async function POST(request: Request) {
  const body = await request.json();
  return NextResponse.json({ status: "REVIEW_READY", post: renderMockPost(body.ideaId) });
}
