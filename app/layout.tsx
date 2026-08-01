import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "BMT · Personal Brand Studio",
  description: "사진과 말로 시작하는 개인 브랜드 콘텐츠 스튜디오",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
