import type { ToolArchive, ToolResult } from "./runtime-types.js";

type WebPage = { url: string; title: string; text: string; links?: string[] };
type WebError = { url: string; error: string; status?: number };

/** Decode only the known TinyFish response envelope, leaving original facts intact. */
export function webResult(result: ToolResult): { pages: WebPage[]; errors: WebError[] } | undefined {
  if (result.isError || result.content.some((part) => part.type !== "text")) return;
  try {
    const value = JSON.parse(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"));
    if (!Array.isArray(value.results) || value.results.some((page: WebPage) =>
      !page || typeof page.url !== "string" || typeof page.text !== "string" ||
      (page.links !== undefined && (!Array.isArray(page.links) || page.links.some((link) => typeof link !== "string"))))) return;
    if (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.some((error: WebError) =>
      !error || typeof error.url !== "string" || typeof error.error !== "string"))) return;
    return { pages: value.results.map((page: WebPage) => ({ url: page.url, title: typeof page.title === "string" ? page.title : "", text: page.text,
      links: [...new Set(page.links ?? [])] })),
      errors: value.errors ?? [] };
  } catch { return; }
}

function prefix(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

export function webReadPath(archive: ToolArchive, page: number, byte = 0): string {
  return `${archive.path}#web=${page}&sha256=${archive.sha256}&byte=${byte}`;
}

export function webResultBody(result: ToolResult): string | undefined {
  const web = webResult(result);
  if (!web) return;
  return [...web.pages.map((page, index) => `页面 ${index + 1}：${page.title}\nURL：${page.url}\n${webPageBody(page)}`),
    ...web.errors.map((error) => `抓取失败：${error.url}\n${error.error}${error.status ? `（HTTP ${error.status}）` : ""}`)].join("\n\n");
}

export function webPageBody(page: WebPage): string {
  return page.text + (page.links?.length ? `\n\n页面链接：\n${page.links.join("\n")}` : "");
}

function relevantLinks(page: WebPage): string[] {
  const links = page.links ?? [];
  try {
    const source = new URL(page.url);
    const descendant = (link: string) => {
      try { const url = new URL(link); return url.origin === source.origin && url.pathname.startsWith(source.pathname.replace(/\/$/, "") + "/"); }
      catch { return false; }
    };
    return [...links.filter(descendant), ...links.filter((link) => !descendant(link))];
  } catch { return links; }
}

/** Give small pages priority over previews of large siblings, within one response budget. */
export function webResultPreview(result: ToolResult, archive: ToolArchive): ToolResult["content"] | undefined {
  const web = webResult(result);
  if (!web || web.pages.length + web.errors.length > 10) return;
  const lengths = web.pages.map((page) => page.text.length <= 4096 ? Array.from(page.text).length : 240);
  const linkCounts = web.pages.map((page) => Math.min(page.links?.length ?? 0, 6));
  const render = () => [{ type: "text" as const, text: [
    "网页结果（原始内容已归档；以下按页展示，未展示的正文可用 read 续读）：",
    ...web.pages.map((page, index) => {
      const excerpt = prefix(page.text, lengths[index]!);
      const links = relevantLinks(page).slice(0, linkCounts[index]);
      return `\n页面 ${index + 1}：${prefix(page.title, 80)}\nURL：${prefix(page.url, 240)}\n${excerpt}` +
        (excerpt === page.text ? "\n[正文完整]" : "\n[正文未完整展示]") +
        (links.length ? `\n页面链接（展示 ${links.length}/${page.links!.length}）：\n${links.map((link) => prefix(link, 300)).join("\n")}` : "") +
        (excerpt !== page.text || (page.links?.length ?? 0) > links.length || links.some((link) => Array.from(link).length > 300) ?
          `\n[读取完整正文与链接：read(${JSON.stringify({ path: webReadPath(archive, index + 1) })})]` : "");
    }),
    ...web.errors.map((error) => `\n抓取失败：${prefix(error.url, 240)}\n${prefix(error.error, 160)}${error.status ? `（HTTP ${error.status}）` : ""}`),
  ].join("\n") }];
  let content = render();
  while (Buffer.byteLength(JSON.stringify(content)) > 7000) {
    // Trim long-page previews first; short pages are the more useful routing evidence.
    let index = lengths.findIndex((length, i) => length > 0 && web.pages[i]!.text.length > 4096);
    if (index < 0) index = lengths.indexOf(Math.max(...lengths));
    if (index >= 0 && lengths[index]! > 0) lengths[index] = Math.max(0, lengths[index]! - 100);
    else {
      const linksIndex = linkCounts.indexOf(Math.max(...linkCounts));
      if (linksIndex < 0 || linkCounts[linksIndex] === 0) return;
      linkCounts[linksIndex] = linkCounts[linksIndex]! - 1;
    }
    content = render();
  }
  return content;
}
