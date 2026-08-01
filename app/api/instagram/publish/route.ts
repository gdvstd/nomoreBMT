import { NextResponse } from "next/server";
import { z } from "zod";

import {
  getInstagramPublishingProfile,
  InstagramPublishingError,
  isInstagramPublishingConfigured,
  publishInstagramCarousel,
} from "@/lib/instagram/publishing";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 180;
export const dynamic = "force-dynamic";

const publishRequestSchema = z.object({
  projectId: z.string().uuid(),
  caption: z.string().max(2_200),
  storagePaths: z.array(z.string().min(1).max(1_000)).min(2).max(10),
});

async function authenticatedClient() {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return { error: "Supabase is not configured.", status: 503 } as const;
  }

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return { error: "로그인 후 Instagram에 게시할 수 있어요.", status: 401 } as const;
  }

  return { supabase, user: data.user } as const;
}

export async function GET() {
  const auth = await authenticatedClient();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!isInstagramPublishingConfigured()) {
    return NextResponse.json(
      {
        configured: false,
        error: "INSTAGRAM_ACCESS_TOKEN is not configured.",
      },
      { status: 503 },
    );
  }

  try {
    const profile = await getInstagramPublishingProfile();
    return NextResponse.json({ configured: true, profile });
  } catch (error) {
    return publishingErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await authenticatedClient();
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }
  if (!isInstagramPublishingConfigured()) {
    return NextResponse.json(
      { error: "INSTAGRAM_ACCESS_TOKEN is not configured." },
      { status: 503 },
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = publishRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid Instagram publish request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { projectId, storagePaths, caption } = parsed.data;
  const expectedPrefix = `${auth.user.id}/${projectId}/generated/`;
  if (
    new Set(storagePaths).size !== storagePaths.length ||
    storagePaths.some((path) => !path.startsWith(expectedPrefix))
  ) {
    return NextResponse.json(
      { error: "게시 이미지 경로가 현재 사용자 또는 프로젝트와 일치하지 않아요." },
      { status: 403 },
    );
  }

  try {
    const imageUrls: string[] = [];
    for (const storagePath of storagePaths) {
      const { data, error } = await auth.supabase.storage
        .from("project-assets")
        .createSignedUrl(storagePath, 60 * 60);
      if (error || !data.signedUrl) {
        throw new Error(
          error?.message ?? `Could not sign generated image ${storagePath}.`,
        );
      }
      imageUrls.push(data.signedUrl);
    }

    const result = await publishInstagramCarousel({ imageUrls, caption });
    return NextResponse.json({
      status: "PUBLISHED",
      ...result,
    });
  } catch (error) {
    console.error(
      "[instagram-publish]",
      error instanceof Error ? error.message : error,
    );
    return publishingErrorResponse(error);
  }
}

function publishingErrorResponse(error: unknown) {
  if (error instanceof InstagramPublishingError) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        subcode: error.subcode,
      },
      { status: error.status >= 400 && error.status < 600 ? error.status : 502 },
    );
  }

  return NextResponse.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Instagram 게시 중 알 수 없는 오류가 발생했어요.",
    },
    { status: 500 },
  );
}
