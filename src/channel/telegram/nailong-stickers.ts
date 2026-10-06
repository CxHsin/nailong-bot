import { randomInt } from "node:crypto";

// Visually reviewed from https://t.me/addstickers/yule8273 (zero-based source indices).
export const NAILONG_STICKERS = {
  "feed": [
    {
      "fileId": "CAACAgUAAxUAAWrE53hdemqb9UGmAoJYZ_kTwRnpAAIfFQAC1JXoVsvX34Hrr1bMPQQ",
      "sourceIndex": 29,
      "description": "吃零食"
    },
    {
      "fileId": "CAACAgUAAxUAAWrE53gu7QcohUrIlLzs6DDdEDN4AALHEQADFOlW4kzPyD8XeZQ9BA",
      "sourceIndex": 46,
      "description": "舔棒棒糖"
    },
    {
      "fileId": "CAACAgUAAxUAAWrE53jH9qCDQEIcx9IpSaAahwYYAAIVEgACRPXpVj0Uxlf5LRscPQQ",
      "sourceIndex": 50,
      "description": "吃爆米花"
    }
  ],
  "dance": [
    {
      "fileId": "CAACAgUAAxUAAWrE53iwrHovAYP-YmiEMrQPdcI7AAKxEQACom7oVq7mTRMhw-fVPQQ",
      "sourceIndex": 52,
      "description": "扭腰跳舞"
    },
    {
      "fileId": "CAACAgUAAxUAAWrE53g4RPR37clwfY-GlsG4QMQBAAIjEQAClhoYV0Pbc-lcfmq6PQQ",
      "sourceIndex": 68,
      "description": "摆手跳舞"
    },
    {
      "fileId": "CAACAgUAAxUAAWrE53hmTt4oqVIHTY15FgKhtNhaAALuKwACrODoVibjxnEGDJw9PQQ",
      "sourceIndex": 40,
      "description": "摇摆扭动"
    }
  ]
} as const;

export function createNailongStickerPicker() {
  const last = new Map<string, string>();
  return (category: string): string => {
    if (category !== "feed" && category !== "dance") throw new Error("未知奶龙贴纸分类");
    const choices = NAILONG_STICKERS[category].filter((item) => item.fileId !== last.get(category));
    const picked = choices[randomInt(choices.length)]!.fileId;
    last.set(category, picked);
    return picked;
  };
}
