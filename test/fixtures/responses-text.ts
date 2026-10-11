import type { ServerResponse } from "node:http";

export function sendResponsesText(res: ServerResponse, id: string, phase: "commentary" | "final_answer", text: string) {
  const item = { type: "message", id, role: "assistant", status: "completed", phase,
    content: [{ type: "output_text", text, annotations: [] }] };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end([{ type: "response.created", response: { id: "response", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, item_id: id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, item_id: id, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "response", status: "completed", usage: { input_tokens: 50, output_tokens: 10 } } },
  ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}
