import { NextResponse } from "next/server";
import { mockIdeas } from "@/lib/mock-agents";

export async function POST() {
  return NextResponse.json({ status: "IDEAS_READY", ideas: mockIdeas });
}
