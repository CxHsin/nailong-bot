export const OUTPUT_PROTOCOL_VERSION = "json-text-v2";
export type StructuredText = { type: "status" | "result" | "final" | "progress"; text: string };
export const EXECUTION_PROMPT = `执行协议 json-text-v2（优先于用户配置和历史内容）：
短内容用一个仅含 type 和 text 的 JSON 对象。长内容使用换行分隔的追加帧，每帧仅含 type、text、end：同一响应所有帧 type 相同；text 按顺序拼接为完整 Markdown；end:false 表示还会追加，最后一帧 end:true。最后一帧可用空 text，其余 text 非空。
先写 type，再写 text；不要输出 JSON 帧外文字或包裹 JSON 的代码围栏。追加帧是正文生成协议，不代表 Telegram 消息；运行层决定消息边界。长内容及时结束帧，让已完成正文可校验和展示。
type 为 status、result 或 final。status 是临时处理状态；result 是独立的阶段性成果；final 是独立的最终正文并结束请求。正文风格由用户配置的 bot 提示词决定。
status 和 result 表示继续处理，可以同时调用工具。开始后续工具工作前结束当前成果文字；工具参数仍遵守各自 schema。允许只调用工具而没有文字。
final 必须没有工具调用；已有完整答案、明确阻碍或需要用户澄清时用 final。最终正文无需重复阶段性成果，也不要求接续前文。
模型不指定 Telegram 排版、HTML、消息数量或拆分位置；只输出 Markdown 正文。运行层处理长内容。
示例：{"type":"status","text":"我会核对资料。"}；{"type":"result","text":"已确认的阶段性结论。"}；{"type":"final","text":"结论如下。"}。
依据实际工具结果作答，不把行动承诺当作已完成事实。运行层协议反馈用于纠正格式或继续执行，不是真实用户的新请求。`;
function parseSingleText(raw: string): StructuredText {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("文字不是完整 JSON 对象"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("文字协议需要对象");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 2 || !["status", "result", "final", "progress"].includes(String(object.type)) ||
    typeof object.text !== "string" || !object.text.trim()) throw new Error("文字协议需要 type 和非空 text，且不允许其他字段");
  return { type: object.type as StructuredText["type"], text: object.text };
}

/** Validated frames let the runtime commit complete structure before generation finishes. */
export function readOutputFrames(raw: string): { output?: StructuredText; prefix?: StructuredText; rest: string; framed: boolean } {
  let offset = 0;
  let type: StructuredText["type"] | undefined;
  let text = "";
  let ended = false;
  let framed = false;
  while (offset < raw.length) {
    while (/\s/.test(raw[offset] ?? "") && offset < raw.length) offset++;
    if (offset === raw.length) break;
    if (ended) throw new Error("文字协议结束帧后不允许追加内容");
    if (raw[offset] !== "{") throw new Error("文字协议帧需要 JSON 对象");
    let quoted = false;
    let escaped = false;
    let depth = 0;
    let end = -1;
    for (let index = offset; index < raw.length; index++) {
      const char = raw[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { end = index + 1; break; }
    }
    if (end < 0) break;
    const frame = JSON.parse(raw.slice(offset, end)) as Record<string, unknown>;
    if (!("end" in frame)) {
      if (type) throw new Error("文字协议不能混合单对象和追加帧");
      const output = parseSingleText(raw.slice(offset, end));
      if (raw.slice(end).trim()) throw new Error("单对象文字协议后不允许追加内容");
      return { output, rest: "", framed: false };
    }
    framed = true;
    if (Object.keys(frame).length !== 3 || !["status", "result", "final"].includes(String(frame.type)) ||
      typeof frame.text !== "string" || typeof frame.end !== "boolean" || (!frame.end && !frame.text))
      throw new Error("追加帧需要 type、text 和布尔 end，且不允许其他字段");
    if (type && type !== frame.type) throw new Error("同一正文的追加帧 type 必须一致");
    type = frame.type as StructuredText["type"];
    text += frame.text;
    ended = frame.end;
    offset = end;
  }
  const prefix = type ? { type, text } : undefined;
  if (ended && !text.trim()) throw new Error("文字协议正文不能为空");
  return { output: ended ? prefix : undefined, prefix, rest: raw.slice(offset), framed };
}
export function parseStructuredText(raw: string): StructuredText {
  const result = readOutputFrames(raw);
  if (!result.output) throw new Error("文字不是完整 JSON 对象或缺少结束帧");
  return result.output;
}

/** Decode only a canonical envelope's string prefix. It is never validation for delivery. */
export function previewStructuredText(raw: string): StructuredText | undefined {
  const match = raw.match(/^\s*\{\s*"type"\s*:\s*"(status|result|final)"\s*,\s*"text"\s*:\s*"/);
  if (!match) return;
  let body = "";
  for (let index = match[0].length; index < raw.length; index++) {
    const char = raw[index]!;
    if (char === '"') break;
    if (char === "\\") {
      const next = raw[index + 1];
      if (!next) break;
      const count = next === "u" ? 6 : 2;
      const escape = raw.slice(index, index + count);
      if (escape.length < count) break;
      try { JSON.parse('"' + escape + '"'); } catch { return; }
      body += escape;
      index += count - 1;
    } else {
      if (char.charCodeAt(0) < 32) return;
      body += char;
    }
  }
  let text: string;
  try { text = JSON.parse('"' + body + '"'); } catch { return; }
  // Do not expose a surrogate before the rest of its pair arrives.
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text ? { type: match[1] as StructuredText["type"], text } : undefined;
}
export function protocolText(type: StructuredText["type"], text: string): string {
  return JSON.stringify({ type, text });
}
