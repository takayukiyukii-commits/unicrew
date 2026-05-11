import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "UNICREW Editor",
  description:
    "UNICREW エクスプローラーから開いたファイルをタブで切り替えるエディタ別ウィンドウ。",
};

export default function EditorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
