import { NextResponse } from "next/server";

import {
  EditorInputGenerationError,
  generateEditorInput,
  generateEditorInputRequestSchema,
} from "@/lib/editor-input";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 180;

type Params = { params: Promise<{ id: string }> };

export async function POST(request: Request, { params }: Params) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "OPENAI_API_KEY is not configured" },
      { status: 503 },
    );
  }

  const { id: projectId } = await params;
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

  const body = await request.json().catch(() => null);
  const parsed = generateEditorInputRequestSchema.safeParse({
    ...(body ?? {}),
    taskId: projectId,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid EditorInput request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (
    parsed.data.userAssets.some(
      (asset) =>
        asset.projectId !== projectId || asset.sourceType !== "user_upload",
    ) ||
    parsed.data.referenceAssets.some(
      (asset) =>
        asset.projectId !== projectId ||
        asset.sourceType !== "instagram_reference",
    )
  ) {
    return NextResponse.json(
      { error: "Asset project or source type mismatch" },
      { status: 400 },
    );
  }

  const requestedAssets = [
    ...parsed.data.userAssets,
    ...parsed.data.referenceAssets,
  ];
  const { data: storedRows, error: storedRowsError } = await supabase
    .from("project_assets")
    .select("asset_id, storage_path, source_type")
    .eq("user_id", authData.user.id)
    .eq("project_id", projectId)
    .in(
      "asset_id",
      requestedAssets.map((asset) => asset.assetId),
    );
  if (storedRowsError) {
    return NextResponse.json(
      { error: "저장된 project asset을 확인하지 못했어요." },
      { status: 502 },
    );
  }
  const storedByAssetId = new Map(
    (storedRows ?? []).map((row) => [row.asset_id, row]),
  );
  const hasUnownedAsset = requestedAssets.some((asset) => {
    const stored = storedByAssetId.get(asset.assetId);
    return (
      !stored ||
      stored.storage_path !== asset.storagePath ||
      stored.source_type !== asset.sourceType
    );
  });
  if (hasUnownedAsset) {
    return NextResponse.json(
      { error: "현재 사용자가 소유하지 않은 asset이 포함됐어요." },
      { status: 403 },
    );
  }

  try {
    const result = await generateEditorInput(parsed.data);
    console.info("EditorInput generated", {
      projectId,
      traceId: result.traceId,
      attempts: result.attempts,
      slideCount: result.editorInput.slides.length,
      sourceAssetIds: result.editorInput.slides.map(
        (slide) => slide.sourceAssetId,
      ),
    });
    return NextResponse.json({ status: "EDITOR_INPUT_READY", ...result });
  } catch (error) {
    console.error("EditorInput generation failed", {
      projectId,
      traceId: error instanceof EditorInputGenerationError
        ? error.traceId
        : undefined,
      attempts: error instanceof EditorInputGenerationError
        ? error.attempts
        : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error: "EditorInput을 생성하지 못했어요.",
        detail: error instanceof Error ? error.message : String(error),
        traceId: error instanceof EditorInputGenerationError
          ? error.traceId
          : undefined,
        attempts: error instanceof EditorInputGenerationError
          ? error.attempts
          : undefined,
      },
      { status: 502 },
    );
  }
}
