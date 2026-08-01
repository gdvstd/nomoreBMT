import type { Idea, RenderedPost } from "./types";

export const mockIdeas: Idea[] = [
  {
    id: "guide",
    label: "IDEA 01 · SAVEABLE GUIDE",
    title: "강릉에서 아무 데나 들어가기 싫다면",
    hook: "사진 속 장소를 동선으로 엮어, 저장하고 싶은 여행 가이드로 만듭니다.",
    description: "아침부터 저녁까지 이어지는 1박 2일 맛집 동선. 정보가 선명해 저장과 공유를 유도합니다.",
    format: "정보형 캐러셀 · 7 slides",
    assets: ["바다 산책", "초당 순두부", "오션뷰 카페"],
    slides: ["강릉 맛집 동선", "아침: 초당 순두부", "점심: 바다 앞 한 끼", "오후: 오션뷰 카페", "저녁: 여행의 마지막 식사"],
    accent: "coral",
  },
  {
    id: "diary",
    label: "IDEA 02 · TRAVEL DIARY",
    title: "이번 강릉 여행은 음식이 오래 남았다",
    hook: "장소 추천보다 한 사람의 취향과 감정을 먼저 보여주는 기록형 포스트입니다.",
    description: "사진의 온도와 짧은 문장을 이어 붙여, 팔로워가 여행 장면 안으로 들어오게 합니다.",
    format: "스토리형 캐러셀 · 6 slides",
    assets: ["창가의 식사", "시장 골목", "노을빛 테이블"],
    slides: ["이번 여행의 첫 장면", "바다보다 먼저 찾은 것", "기억에 남은 한입", "다음에 다시 올 이유", "강릉, 저장해두기"],
    accent: "blue",
  },
];

export function renderMockPost(ideaId: string): RenderedPost {
  const idea = mockIdeas.find((item) => item.id === ideaId) ?? mockIdeas[0];
  const colors = idea.accent === "coral"
    ? ["sunset", "seafoam", "sand", "night", "coral"]
    : ["dawn", "ocean", "cream", "twilight", "blue"];

  return {
    ideaId: idea.id,
    slides: idea.slides.map((title, index) => ({
      eyebrow: `${String(index + 1).padStart(2, "0")} / ${idea.slides.length}`,
      title,
      copy: index === 0 ? idea.hook : "사진의 여백을 살려 짧고 오래 남는 문장으로 편집했습니다.",
      gradient: colors[index % colors.length],
    })),
    caption: "강릉에서 좋았던 장면들을 한 번에 정리해봤어요. 다음 여행을 계획하고 있다면 저장해두세요.\n\n#강릉여행 #강릉맛집 #국내여행",
  };
}
