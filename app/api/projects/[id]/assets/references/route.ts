import { NextResponse } from "next/server";
import { z } from "zod";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProjectAsset } from "@/lib/project-assets/types";

export const runtime = "nodejs";
export const maxDuration = 120;

const BUCKET = "project-assets";
const MAX_BYTES = 20 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

const inputSchema = z.object({
  items: z
    .array(
      z.object({
        assetId: z.string().regex(/^[A-Za-z0-9_-]+$/).max(200),
        imageUrl: z.string().url(),
        instagramUrl: z.string().url(),
        sourceSlideIndex: z.number().int().positive().max(20),
      }),
    )
    .max(2),
});

type Params = { params: Promise<{ id: string }> };

function isAllowedReferenceHost(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return (
      hostname === "cdninstagram.com" ||
      hostname.endsWith(".cdninstagram.com") ||
      hostname === "fbcdn.net" ||
      hostname.endsWith(".fbcdn.net")
    );
  } catch {
    return false;
  }
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

export async function POST(request: Request, { params }: Params) {
  const { id: projectId } = await params;
  if (!z.string().uuid().safeParse(projectId).success) {
    return NextResponse.json({ error: "Invalid project ID" }, { status: 400 });
  }

  const parsed = inputSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid reference asset input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "Supabase is not configured" },
      { status: 503 },
    );
  }
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const assets: ProjectAsset[] = [];
    for (const item of parsed.data.items) {
      if (!isAllowedReferenceHost(item.imageUrl)) {
        throw new Error("허용되지 않은 reference 이미지 host입니다.");
      }

      const imageResponse = await fetch(item.imageUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(30_000),
      });
      if (!imageResponse.ok || !isAllowedReferenceHost(imageResponse.url)) {
        throw new Error(`Reference 이미지 다운로드 실패 (${imageResponse.status})`);
      }

      const mimeType =
        imageResponse.headers.get("content-type")?.split(";")[0].trim() || "";
      if (!allowedMimeTypes.has(mimeType)) {
        throw new Error(`지원하지 않는 reference 이미지 형식: ${mimeType || "unknown"}`);
      }
      const bytes = new Uint8Array(await imageResponse.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) {
        throw new Error("Reference 이미지가 20MB를 초과합니다.");
      }

      const storagePath = [
        authData.user.id,
        projectId,
        "reference",
        `${item.assetId}.${extensionForMimeType(mimeType)}`,
      ].join("/");
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(storagePath, bytes, {
          contentType: mimeType,
          upsert: true,
        });
      if (uploadError) throw uploadError;

      const { error: metadataError } = await supabase
        .from("project_assets")
        .upsert(
          {
            user_id: authData.user.id,
            project_id: projectId,
            asset_id: item.assetId,
            source_type: "instagram_reference",
            storage_path: storagePath,
            mime_type: mimeType,
            source_url: item.imageUrl,
            source_post_url: item.instagramUrl,
            source_slide_index: item.sourceSlideIndex,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,project_id,asset_id" },
        );
      if (metadataError) throw metadataError;

      const { data: signed, error: signedError } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
      if (signedError) throw signedError;

      assets.push({
        assetId: item.assetId,
        projectId,
        sourceType: "instagram_reference",
        storagePath,
        signedUrl: signed.signedUrl,
        mimeType,
        sourceUrl: item.imageUrl,
        sourcePostUrl: item.instagramUrl,
        sourceSlideIndex: item.sourceSlideIndex,
      });
    }

    return NextResponse.json({ status: "REFERENCE_ASSETS_STORED", assets });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Reference 이미지를 저장하지 못했어요.",
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
