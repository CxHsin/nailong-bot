// Magpie's Agent plugin API (no Node globals or imports).
export const agent = {
  id: "nailong", name: "Nailong Bot",
  config: "~/.config/nailong/magpie.json", format: "json",
  dir: "~/.config/nailong", model: "model", prefix: "magpie/",
  ua: ["nailong"],
  notice: "Nailong 自动重新读取连接；模型更改用于下一次主请求。思考等级在 Telegram 调整。",
};

export function connect({ gateway }) {
  return { baseUrl: gateway.v1, apiKey: gateway.key };
}
