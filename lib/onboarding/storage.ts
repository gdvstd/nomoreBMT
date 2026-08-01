"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase";

import {
  storedOnboardingProfileSchema,
  type StoredOnboardingProfile,
} from "./types";

const STORAGE_KEY = "nomorebmt:onboarding-profile:v1";

function storageKey(userId?: string) {
  return userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;
}

export type OnboardingStorageResult = {
  profile: StoredOnboardingProfile;
  storage: "local" | "supabase";
  warning?: string;
};

function readLocalProfile(userId?: string): StoredOnboardingProfile | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = storedOnboardingProfileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeLocalProfile(profile: StoredOnboardingProfile, userId?: string) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(profile));
  }
}

export async function loadOnboardingProfile(): Promise<OnboardingStorageResult | null> {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    const localProfile = readLocalProfile();
    return localProfile ? { profile: localProfile, storage: "local" } : null;
  }

  try {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) {
      const localProfile = readLocalProfile();
      return localProfile ? { profile: localProfile, storage: "local" } : null;
    }

    const localProfile = readLocalProfile(authData.user.id);

    const { data, error } = await supabase
      .from("user_brand_contexts")
      .select("answers, context, updated_at")
      .eq("user_id", authData.user.id)
      .maybeSingle();

    if (error) throw error;
    const remote = data
      ? storedOnboardingProfileSchema.safeParse({
          answers: data.answers,
          context: data.context,
          updatedAt: data.updated_at,
        })
      : null;

    if (remote?.success) {
      writeLocalProfile(remote.data, authData.user.id);
      return { profile: remote.data, storage: "supabase" };
    }

    return localProfile ? { profile: localProfile, storage: "local" } : null;
  } catch (error) {
    return null;
  }
}

export async function saveOnboardingProfile(
  profile: StoredOnboardingProfile,
): Promise<OnboardingStorageResult> {
  const validated = storedOnboardingProfileSchema.parse(profile);

  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    writeLocalProfile(validated);
    return { profile: validated, storage: "local" };
  }

  let authenticatedUserId: string | null = null;

  try {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) {
      writeLocalProfile(validated);
      return { profile: validated, storage: "local" };
    }
    authenticatedUserId = authData.user.id;

    const { error } = await supabase.from("user_brand_contexts").upsert(
      {
        user_id: authData.user.id,
        account_name: validated.context.accountName,
        instagram_handle: validated.context.instagramHandle,
        answers: validated.answers,
        context: validated.context,
        updated_at: validated.updatedAt,
      },
      { onConflict: "user_id" },
    );

    if (error) throw error;
    writeLocalProfile(validated, authData.user.id);
    return { profile: validated, storage: "supabase" };
  } catch (error) {
    if (authenticatedUserId) {
      throw error;
    }
    return {
      profile: validated,
      storage: "local",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
