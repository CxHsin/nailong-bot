const names: Record<string, string> = {
  grep: "奶龙雷达", find: "奶龙嗅觉", write: "奶龙踩脚印", edit: "奶龙大尾巴乱涂乱画",
  web_search: "奶龙去外面的世界探险", web_fetch: "奶龙翻网页小本本",
};

/** Presentation only: SDK names, arguments and persisted tool identities stay exact. */
export function toolDisplayName(name: string): string { return names[name] ?? name; }
