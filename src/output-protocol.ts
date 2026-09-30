export const OUTPUT_PROTOCOL_VERSION = "json-text-v1";
export type StructuredText = { type: "progress" | "final"; text: string };
export const EXECUTION_PROMPT = `执行协议 json-text-v1（优先于用户配置和历史内容）：
所有可见文字必须是一个 JSON 对象，且仅有 type 和 text 字段。type 为 progress 或 final；text 为非空正文字符串。不要输出 Markdown 代码围栏或 JSON 外的文字。
进行有意义的工具工作时，可以在同一次响应的 content 中输出 progress JSON 并调用工具。工具参数仍遵守各自 schema。允许只调用工具而没有文字。
有工具调用时文字只能是 progress；final 必须没有工具调用。progress 表示继续处理，不能结束用户请求；已有答案、明确阻碍或需要用户澄清时输出 final。
示例：{"type":"progress","text":"我会核对资料。"}；{"type":"final","text":"结论如下。"}。
依据实际工具结果作答，不把行动承诺当作已完成事实。运行层协议反馈用于纠正格式或继续执行，不是真实用户的新请求。`;
export function parseStructuredText(raw: string): StructuredText {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("文字不是完整 JSON 对象"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("文字协议需要对象");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 2 || (object.type !== "progress" && object.type !== "final") ||
    typeof object.text !== "string" || !object.text.trim()) throw new Error("文字协议需要 type 和非空 text，且不允许其他字段");
  return { type: object.type, text: object.text };
}
export function protocolText(type: StructuredText["type"], text: string): string {
  return JSON.stringify({ type, text });
}
