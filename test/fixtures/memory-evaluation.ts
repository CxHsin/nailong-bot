export const EVALUATION_START = Date.parse("2026-09-01T08:00:00Z");
export const EVALUATION_NOW = EVALUATION_START + 3 * 86400_000;
const axes = { game: [1, 0, 0, 0, 0], care: [0, 1, 0, 0, 0], noise: [0, 0, 1, 0, 0], fact: [0, 0, 0, 1, 0], taste: [0, 0, 0, 0, 1] };
export const evaluationCorpus = [
  { id: "game", text: "limboo 是我的舍友，我们玩杀戮尖塔", axis: "game", minutes: 0 },
  { id: "care", text: "引流条每天换药", axis: "care", minutes: 1 },
  { id: "local-link", text: "limboo 跟我讨论伤口", axis: "game", minutes: 2, activated: ["game", "care"] },
  { id: "far", text: "周五复诊挂号", axis: "care", minutes: 2880, activated: ["game", "care"] },
  { id: "mixed-name", text: "阿璃和 Project Q7 是同一位搭档", axis: "noise", minutes: 5 },
  { id: "blood", text: "我的血型是 AB 型", axis: "fact", minutes: 6 },
  { id: "preference", text: "我不喜欢喝咖啡", assistant: "你可以试试黑咖啡（助手建议，不是用户偏好）", axis: "taste", minutes: 7 },
  { id: "hub", text: "你好，谢谢，下次聊", axis: "noise", minutes: 8 },
  { id: "long", text: "无关前言".repeat(6000) + "杀戮尖塔是周末的游戏🎮", axis: "game", minutes: 9 },
  { id: "old-place", text: "limboo 的旧地点 old_hidden", axis: "game", minutes: 10, excluded: true },
  { id: "new-place", text: "limboo 的新地点 new_allowed", axis: "game", minutes: 11 },
  ...Array.from({ length: 10 }, (_, index) => ({ id: `a-noise-${index}`, text: `无关背景：天气备忘编号${index}`, axis: "noise", minutes: 12 + index, activated: ["hub"] })),
];
export const evaluationCases = [
  { name: "中文/混合专名", query: "阿璃和 Project Q7 是谁", axis: "noise", required: ["mixed-name"], background: [] },
  { name: "明确事实", query: "我的血型是什么", axis: "fact", required: ["blood"], background: [] },
  { name: "局部关联", query: "limboo 的近况", axis: "game", required: ["game", "care"], background: ["local-link", "far", "long", "new-place"] },
  { name: "远场关联", query: "杀戮尖塔的同伴和周五计划", axis: "game", required: ["game", "far"], background: ["care", "local-link", "long", "new-place"] },
  { name: "hub/无关背景", query: "limboo 玩什么", axis: "game", required: ["game"], background: ["local-link", "care", "far", "long", "new-place"] },
  { name: "角色区分", query: "我对咖啡的偏好是什么", axis: "taste", required: ["preference"], background: [], quote: "助手建议，不是用户偏好" },
  { name: "长期闲置直接查回", query: "AB 型血的旧记录", axis: "fact", required: ["blood"], background: [], now: EVALUATION_NOW + 90 * 86400_000 },
  { name: "预算连续片段", query: "杀戮尖塔是周末的游戏", axis: "game", required: ["long"], background: ["game", "local-link"], budget: 350, akashaQuote: "杀戮尖塔是周末的游戏" },
  { name: "遗忘/新身份", query: "limboo 的新地点", axis: "game", required: ["new-place"], background: ["game", "local-link", "care", "far", "long"], inspectExcluded: "old-place" },
  { name: "无关问题负例", query: "本周气温怎么样", axis: "noise", required: [], background: [] },
];
export function evaluationVector(text: string): number[] {
  const item = evaluationCorpus.find((entry) => entry.text === text || entry.assistant === text) ?? evaluationCases.find((entry) => entry.query === text);
  const axis = item?.axis ?? (text.includes("杀戮尖塔是周末的游戏") ? "game" : "noise");
  return axes[axis as keyof typeof axes];
}
