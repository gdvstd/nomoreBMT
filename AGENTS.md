# noMoreBMT Agent Guide

이 저장소의 마케터 Agent는 사용자의 기존 Instagram 계정을 분석하고,
사용자가 제작하려는 주제와 유사한 공개 Instagram reference를 찾아 편집자
Agent가 사용할 근거 중심 context를 만든다.

## Agent workflow

```text
사용자의 게시물 주제
→ 기존 계정 게시물 분석
→ 유사 Instagram reference 탐색
→ 계정 분석과 reference에서 재사용 가능한 원리 추출
→ 편집자 Agent에 context 전달
```

사용자가 기존 계정 분석과 reference 탐색을 모두 요청하면 두 작업을 위 순서로
실행한다. 한 작업만 요청하면 해당 스킬만 사용한다.

## Skill routing

### 기존 Instagram 계정 분석

다음 요청에는 `skills/analyze-instagram-account/SKILL.md`를 사용한다.

- 기존 게시물의 winning pattern 또는 weak pattern 분석
- 좋아요, 댓글, 저장, 공유, 도달 등의 성과 분석
- 댓글 반응과 반복 질문 분석
- 카드뉴스 이미지의 가독성, 배치, 디자인 분석
- 캐러셀 슬라이드 순서와 CTA 분석
- 다음 게시물을 위한 편집자 context 생성

실행 전에 아래 파일을 순서대로 전부 읽는다.

1. `skills/analyze-instagram-account/SKILL.md`
2. `skills/analyze-instagram-account/references/output-schema.md`

앱에서는 다음 API를 호출한다.

```http
POST /api/instagram/analyze
Content-Type: application/json
```

```json
{
  "postLimit": 12,
  "commentsPerPost": 20,
  "focus": "다음 카드뉴스 제작에 사용할 개선점 추출"
}
```

반환된 `context.analysis.editorContext`를 편집자 Agent의 주 지침으로 사용하되,
`evidencePosts`, post ID, slide ID, comment ID를 함께 전달한다.

### 유사 Instagram reference 탐색

다음 요청에는 `skills/scout-instagram-references/SKILL.md`를 사용한다.

- Apify를 이용한 사용자 주제와 유사한 Instagram 게시물 검색
- 더 강한 reference 또는 인기 사례 탐색
- 현재 사용되는 hook, 카드뉴스 구조, 시각 패턴 조사
- reference에서 적용할 요소와 피할 요소 추출
- 편집자 Agent용 reference context 생성

실행 전에 아래 파일을 순서대로 전부 읽는다.

1. `skills/scout-instagram-references/SKILL.md`
2. `skills/scout-instagram-references/references/output-schema.md`

앱에서는 다음 API를 호출한다.

```http
POST /api/instagram/references
Content-Type: application/json
```

```json
{
  "topic": "성수동 맛집 추천 카드뉴스",
  "objective": "저장",
  "timeRange": "30d",
  "region": "KR",
  "formatFocus": "carousel",
  "maxReferences": 3
}
```

허용되는 입력값:

- `timeRange`: `7d`, `30d`, `90d`, `any`
- `formatFocus`: `carousel`, `reel`, `single_image`, `all`
- `maxReferences`: 1~3

Apify가 관련 hashtag와 공개 게시물 후보를 수집하며, 현재 MVP는 단일 이미지와
캐러셀만 사용하고 릴스와 동영상 게시물은 제외한다. 누락된 좋아요, 댓글,
좋아요 또는 댓글 수가 누락되면 공개 반응 점수를 계산하지 않고 `null`로
유지한다. 작성자 follower 수는 조회하거나 점수 계산에 사용하지 않는다.

반환된 `context.references`, `context.patterns`,
`context.editorContext`를 편집자 Agent에 전달한다. 사용자에게 결과를 보여줄
때는 `instagramUrl`과 `sources`를 클릭 가능한 링크로 표시한다.

## Combined marketer context

두 스킬을 함께 사용한 경우 편집자 Agent에는 다음 구조로 전달한다.

```json
{
  "userTopic": "사용자가 만들려는 게시물 주제",
  "ownedAccountContext": "POST /api/instagram/analyze의 context",
  "referenceContext": "POST /api/instagram/references의 context",
  "marketerBrief": {
    "keepFromOwnedAccount": [],
    "fixFromOwnedAccount": [],
    "adaptFromReferences": [],
    "avoidCopying": [],
    "recommendedDirection": []
  }
}
```

`marketerBrief`는 두 API의 evidence를 요약하는 계층이다. 원본 context를
삭제하거나 대체하지 않는다.

## Evidence rules

- 공개되지 않은 좋아요, 댓글, 저장, 공유, 조회 수를 추정하지 않는다.
- 누락된 metric을 0으로 취급하지 않는다.
- 실제 `instagram.com/p/`, `instagram.com/reel/` 또는
  `instagram.com/tv/` URL이 검증되지 않은 검색 결과는 reference로 사용하지
  않는다.
- 공개 성과 수치가 없으면 `performanceSignal`을 `unknown`으로 유지한다.
- `public_preview`, `text_only`, `unavailable` evidence를 전체 게시물 분석처럼
  표현하지 않는다.
- 한 개의 저도달 게시물만으로 winning 또는 weak pattern을 확정하지 않는다.
- 관찰, 해석, 가설을 구분하고 confidence와 limitation을 유지한다.
- reference의 고유 문구, 그림, 브랜딩, 슬라이드 구성을 그대로 복제하지
  않는다. `transferableElements`에 기록된 원리만 사용자 브랜드에 맞게
  재해석한다.
- API key, access token, app secret 또는 원본 인증 응답을 출력 context에 넣지
  않는다.

## Failure behavior

- Instagram 인증이 실패하면 reference 검색 결과로 기존 계정 분석을
  대체하지 않는다.
- 검증된 reference가 없으면 빈 `references` 배열과 검색 limitation을
  반환한다.
- 일부 댓글, insight 또는 이미지가 누락돼도 가능한 분석은 계속하되 coverage
  warning을 유지한다.
- API 오류가 발생하면 오류 원인과 실패한 단계를 보고하고 수치를 만들어내지
  않는다.

## Environment

서버에서 사용하는 주요 환경 변수:

```text
OPENAI_API_KEY
OPENAI_MODEL
OPENAI_REFERENCE_MODEL
APIFY_API_TOKEN
INSTAGRAM_ACCESS_TOKEN
INSTAGRAM_API_VERSION
```

실제 값은 `.env.local`에만 저장한다. `.env.example`에는 빈 placeholder만
유지한다.

## Validation

코드 변경 후 다음 검사를 실행한다.

```bash
npx tsc --noEmit
npm run build
```

스킬 파일을 변경한 경우 각 스킬에 대해 skill creator의
`quick_validate.py`도 실행한다.
