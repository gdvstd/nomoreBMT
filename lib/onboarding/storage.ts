"use client";

import { getSupabaseBrowserClient } from "@/lib/supabase";

import {
  storedOnboardingProfileSchema,
  type StoredOnboardingProfile,
} from "./types";

const STORAGE_KEY = "nomorebmt:onboarding-profile:v1";

export type OnboardingStorageResult = {
  profile: StoredOnboardingProfile;
  storage: "local" | "supabase";
  warning?: string;
};

function readLocalProfile(): StoredOnboardingProfile | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = storedOnboardingProfileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeLocalProfile(profile: StoredOnboardingProfile) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  }
}

export async function loadOnboardingProfile(): Promise<OnboardingStorageResult | null> {
  const localProfile = readLocalProfile();
  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    return localProfile ? { profile: localProfile, storage: "local" } : null;
  }

  try {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) {
      return localProfile ? { profile: localProfile, storage: "local" } : null;
    }

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
      writeLocalProfile(remote.data);
      return { profile: remote.data, storage: "supabase" };
    }
  } catch (error) {
    if (localProfile) {
      return {
        profile: localProfile,
        storage: "local",
        warning: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return localProfile ? { profile: localProfile, storage: "local" } : null;
}

export async function saveOnboardingProfile(
  profile: StoredOnboardingProfile,
): Promise<OnboardingStorageResult> {
  const validated = storedOnboardingProfileSchema.parse(profile);
  writeLocalProfile(validated);

  const supabase = getSupabaseBrowserClient();
  if (!supabase) return { profile: validated, storage: "local" };

  try {
    const { data: authData } = await supabase.auth.getUser();
    if (!authData.user) return { profile: validated, storage: "local" };

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
    return { profile: validated, storage: "supabase" };
  } catch (error) {
    return {
      profile: validated,
      storage: "local",
      warning: error instanceof Error ? error.message : String(error),
    };
  }
}
