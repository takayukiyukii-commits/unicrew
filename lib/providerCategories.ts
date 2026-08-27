import type { Provider } from "./types";

export type ProviderCategory =
  | "claude_family"
  | "openai_family"
  | "google_family"
  | "open_local";

export const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  claude_family: "Claude 系",
  openai_family: "OpenAI 系",
  google_family: "Google 系",
  open_local: "ローカル / OSS 系",
};

export const CATEGORY_COLORS: Record<ProviderCategory, string> = {
  claude_family: "#dd6b20",
  openai_family: "#10a37f",
  google_family: "#4285f4",
  open_local: "#7c3aed",
};

export const CATEGORY_DESCRIPTIONS: Record<ProviderCategory, string> = {
  claude_family: "Anthropic Claude 公式 CLI、Claude モデルで動く OSS エージェント",
  openai_family: "OpenAI Codex 公式 CLI、ChatGPT/GPT モデルで動く OSS エージェント",
  google_family: "Google Gemini 公式 CLI、Gemini モデルで動くエージェント",
  open_local: "ローカル LLM（Ollama 等）で動かせる OSS エージェント、API キー不要で起動可",
};

export const PROVIDER_CATEGORY: Record<Provider, ProviderCategory> = {
  claude: "claude_family",
  codex: "openai_family",
  gemini: "google_family",
  goose: "open_local",
  opencode: "open_local",
  // codex-acp は OpenAI API を直接叩く BYOK 経路。色味も codex 公式 CLI と揃える。
  "codex-acp": "openai_family",
  // kiro は AWS Bedrock backed。3大ファミリーに属さないので open_local 扱い（将来 aws_family を増やす可能性あり）。
  kiro: "open_local",
  // qwen は Alibaba DashScope BYOK + Apache-2.0 OSS。3大ファミリーに属さないので open_local 扱い
  // （将来 alibaba_family / oss_family を増やす可能性あり）。
  qwen: "open_local",
  // kimi は Moonshot AI、ACP ネイティブサポート（kimi acp）。OAuth login で認証完結。
  kimi: "open_local",
  // grok は xAI 公式 CLI（@xai-official/grok）、ACP ネイティブ（grok agent stdio）。
  // 3大ファミリーに属さないので open_local 扱い（将来 xai_family を増やす可能性あり）。
  grok: "open_local",
  // cursor は Cursor 公式 Agent CLI（stream-json）。マルチモデルの商用サービスで
  // 3大ファミリーに属さないので open_local 扱い。
  cursor: "open_local",
};

export const CATEGORY_ORDER: ProviderCategory[] = [
  "open_local",
  "claude_family",
  "openai_family",
  "google_family",
];

export function categoryOf(provider: Provider): ProviderCategory {
  return PROVIDER_CATEGORY[provider];
}

export function colorOf(provider: Provider): string {
  return CATEGORY_COLORS[categoryOf(provider)];
}
