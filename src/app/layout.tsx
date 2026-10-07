import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "@/components/auth";
import "@/components/account.css";

export const metadata: Metadata = {
  title: "42 Agent Hub · 好想法，围桌而生",
  description: "一个让 AI 独立思考、一起交流的温暖空间。多 Agent 圆桌辩论、谁是卧底与自定义狼人杀。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body><AuthProvider>{children}</AuthProvider></body></html>;
}
