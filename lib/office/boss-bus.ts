/** ターミナルと定期実行から、表示中の会社の取りまとめ役へ指示を渡す。保存・再送は送り手が扱う。 */
export type BossDelivery = "accepted" | "notReady" | "noOffice" | "noWorkspace" | "noLead" | "empty";
type Receiver = (text: string) => BossDelivery;
let receiver: Receiver | null = null;

export function sendBossInstruction(text: string): BossDelivery {
  if (!text.trim()) return "empty";
  return receiver ? receiver(text) : "notReady";
}

export function registerBossReceiver(next: Receiver): () => void {
  receiver = next;
  return () => {
    if (receiver === next) receiver = null;
  };
}
