import { NextResponse } from "next/server";

// Keep stale browser history from landing on a removed legacy endpoint.
export async function GET(request: Request) {
  return NextResponse.redirect(new URL("/", request.url));
}
