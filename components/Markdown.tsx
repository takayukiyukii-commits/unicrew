"use client";

import ReactMarkdown, { type Options } from "react-markdown";
import { useRemarkPlugins } from "@/lib/remark-plugins";

// remark-gfm を直接 import しないこと（理由は lib/remark-plugins.ts）。
export function Markdown(props: Omit<Options, "remarkPlugins">) {
  const remarkPlugins = useRemarkPlugins();
  return <ReactMarkdown {...props} remarkPlugins={remarkPlugins} />;
}
