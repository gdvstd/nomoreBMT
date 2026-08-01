"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase";

import type { ProjectAsset } from "./types";

const BUCKET = "project-assets";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

export type UserAssetUpload = {
  assetId: string;
  file: File;
  description?: string;
};

function safeFilename(value: string) {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "image";
}

export async function uploadUserProjectAssets(
  projectId: string,
  assets: UserAssetUpload[],
): Promise<ProjectAsset[]> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) throw new Error("Supabase가 설정되지 않았어요.");

  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError) throw authError;
  if (!authData.user) throw new Error("사진을 저장하려면 로그인이 필요해요.");

  const uploaded: ProjectAsset[] = [];
  for (const asset of assets) {
    const storagePath = [
      authData.user.id,
      projectId,
      "user",
      `${asset.assetId}-${safeFilename(asset.file.name)}`,
    ].join("/");

    const { error: uploadError } = await supabase.storage
      .from(BUCKET)
      .upload(storagePath, asset.file, {
        contentType: asset.file.type,
        upsert: true,
      });
    if (uploadError) throw uploadError;

    const { error: metadataError } = await supabase
      .from("project_assets")
      .upsert(
        {
          user_id: authData.user.id,
          project_id: projectId,
          asset_id: asset.assetId,
          source_type: "user_upload",
          storage_path: storagePath,
          original_filename: asset.file.name,
          mime_type: asset.file.type,
          description: asset.description?.trim() || null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,project_id,asset_id" },
      );
    if (metadataError) throw metadataError;

    const { data: signed, error: signedError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (signedError) throw signedError;

    uploaded.push({
      assetId: asset.assetId,
      projectId,
      sourceType: "user_upload",
      storagePath,
      signedUrl: signed.signedUrl,
      name: asset.file.name,
      description: asset.description?.trim() || undefined,
      mimeType: asset.file.type,
    });
  }

  return uploaded;
}
