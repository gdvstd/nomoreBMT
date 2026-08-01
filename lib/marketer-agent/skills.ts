import { readFile } from "node:fs/promises";
import path from "node:path";

export type MarketerSkillName =
  | "analyze-instagram-account"
  | "scout-instagram-references";

const skillCache = new Map<MarketerSkillName, string>();

export async function loadMarketerSkill(name: MarketerSkillName) {
  const cached = skillCache.get(name);
  if (cached) return cached;

  const skillPath = path.join(process.cwd(), "skills", name, "SKILL.md");
  const contents = await readFile(skillPath, "utf8");
  skillCache.set(name, contents);
  return contents;
}
