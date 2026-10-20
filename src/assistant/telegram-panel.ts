import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { Assistant, ControlSnapshot, ControlAction } from "./runtime.js";

type Page = "home" | "models" | "thinking" | "works" | "work" | "cache" | "settings" | "session" | "reset" | "detail" | "satiety";
type View = { page: Page; offset?: number; favorites?: boolean; details?: boolean; model?: string; target?: string; routing?: boolean };
type ButtonAction = { view: View; action?: ControlAction; refresh?: boolean };
type Button = { label: string; value: ButtonAction };
const home: View = { page: "home" };
const PAGE_SIZE = 6;
const frequencyNames = { quiet: "安静", restrained: "克制", natural: "自然活跃", lively: "热闹" } as const;
const statusNames: Record<string, string> = { idle: "空闲", running: "执行中", waiting_model: "等待选择可用模型", paused: "已暂停", queued: "排队中", pending: "排队中", completed: "本轮已结束（目标成果仍需核对）", cancelled: "已取消后续安排", stopping: "停止中", stopped: "已核实停止", unknown: "待核实", background: "后台 helper", helper: "后台 helper", needs_confirmation: "待核实" };
const statusName = (value: string) => statusNames[value] ?? value;
const html = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const count = (value: number | null | undefined) => value == null ? "未知" :
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);

/** Native controls use the authenticated Conversation service boundary, never natural-language routing. */
export function registerTelegramPanel(options: {
  app: Assistant; bot: Bot; ownerId: number; conversationId: string;
  draftsChanged: (enabled: boolean) => Promise<void>;
  reportFailure: (error: unknown) => void;
}) {
  const { app, bot, ownerId, conversationId } = options;
  // Restart invalidates these bounded, short-lived capabilities instead of guessing their target.
  const panels = new Map<string, { messageId: number; expires: number; actions: ButtonAction[]; used: Set<number> }>();
  const commands = new Map<number, Promise<void>>();
  const validOwner = (ctx: Context) => ctx.from?.id === ownerId && ctx.chat?.type === "private" && ctx.chat.id === ownerId;
  const button = (label: string, view: View, action?: ControlAction): Button => ({ label, value: { view, action } });

  async function render(ctx: Context, view: View, snapshot?: ControlSnapshot, note?: string, refresh = false) {
    const s = snapshot ?? await app.controlSnapshot(conversationId, { refresh });
    await options.draftsChanged(s.drafts);
    let text = "";
    const rows: Button[][] = [];
    const selected = s.catalog.find(model => model.id === s.selectedModel);
    const setting = (model?: string, level?: string) => `${model ?? "未选择"}${level ? ` · ${level}` : ""}`;
    const connection = s.connectionError ? "Magpie 连接配置异常，请修复后刷新。" :
      !s.connected ? "Magpie 未连接。请检查本机 Magpie 连接配置。" : "Magpie 已连接";
    const failure = s.catalogStatus === "stale" ? "目录刷新失败；显示上次成功列表，可重试刷新。" :
      s.catalogStatus === "unavailable" ? "模型目录暂不可用，请刷新重试。" : "";
    const usageCount = (field: "input" | "output" | "cacheRead") =>
      count(s.usage[field]) + (s.usage[field] !== null && s.usage.missing[field] > 0 ? "*" : "");
    switch (view.page) {
      case "home":
        text = `🦖 Nailong Bot\n\nStatus: ${s.status}\nTokens: ↑${usageCount("input")} ↓${usageCount("output")}\nCache: R${usageCount("cacheRead")} CH${s.usage.cacheHit == null ? "未知" : `${s.usage.cacheHit.toFixed(1)}%`}\nContext: ${s.context.tokens === undefined || !s.context.window ? "未知" : `~${(s.context.tokens / s.context.window * 100).toFixed(1)}%`}/${count(s.context.window)}${s.usage.missing.requests ? `\n* 仅已知用量 · ${s.usage.missing.requests} 条缺失` : ""}\n\n/model — 选择模型\n/stop — 暂停当前请求\n/resume — 继续暂停工作\n\n${s.connected && !s.connectionError ? "🟢" : "🔴"} ${connection}`;
        if (s.status === "waiting_model") text += "\n等待选择可用模型；已接收输入保留。";
        if (s.pending) text += `\n\n实际请求：${setting(s.actual?.model, s.actual?.thinking)}\n待生效：${setting(s.selectedModel, s.thinking)}\n下一次准备请求使用最新选择。`;
        if (s.selectedModel && !s.selectedAvailable) text += "\n当前选择不可用，请重新选择；上下文与工作保留。";
        rows.push([{ label: `🤖 模型：${s.selectedModel ?? "未选择"}`, value: { view: { page: "models" }, refresh: true } }]);
        if (selected?.reasoning !== false && (selected?.reasoning || selected?.reasoningLevels?.length)) rows.push([button(`🧠 思考等级：${s.thinking ?? "能力未提供"}`, { page: "thinking" })]);
        rows.push([button("📊 缓存统计", { page: "cache" }, { type: "cache" })],
          [button(`🍜 饱食：${s.satiety.label}`, { page: "satiety" }), button("投喂 +25", { page: "satiety" }, { type: "feed", operationId: randomBytes(12).toString("hex") })],
          [{ label: `🧭 全局路由模型：${s.routing.selectedModel ?? "未选择"}`, value: { view: { page: "models", routing: true }, refresh: true } }],
          [button(`⏳ 工作列表：${s.waiting} 等待`, { page: "works" })], [button("⚙️ 设置", { page: "settings" })]);
        break;
      case "models": {
        const catalog = view.routing ? s.routing : s;
        const models = catalog.catalog.filter(model => !view.favorites || s.favorites.includes(model.id));
        const offset = Math.max(0, Math.min(view.offset ?? 0, Math.max(0, Math.ceil(models.length / PAGE_SIZE) - 1) * PAGE_SIZE));
        text = `🤖 ${view.routing ? "全局路由模型 · 整个助手服务共用" : view.favorites ? "常用模型" : "选择模型"}\n\n当前：${models.find(model => model.id === catalog.selectedModel)?.displayName ?? catalog.selectedModel ?? "未选择"}\n${view.details ? "点击模型查看能力与管理收藏。" : "点击即切换 · ✓ 当前模型"}\n第 ${Math.floor(offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(models.length / PAGE_SIZE))} 页 · 共 ${models.length} 个`;
        if (view.routing) text += "\n下一次路由判断生效；不改变主模型或当前工作。";
        if (!catalog.connected || catalog.connectionError) text += `\n${connection}`;
        if (catalog.selectedModel && !catalog.selectedAvailable) text += "\n已选模型不可用，保留原始消息交给主助手处理。";
        if (!models.length) text += view.favorites ? "\n暂无可用常用模型；到全部列表添加收藏。" : "\n目录为空；请在 Magpie 中启用模型后刷新。";
        for (const model of models.slice(offset, offset + PAGE_SIZE)) {
          const current = model.id === catalog.selectedModel ? "✓ " : "";
          const next = { ...view, offset };
          const label = `${current}${model.displayName} · ${model.id.includes("/") ? model.id.slice(0, model.id.lastIndexOf("/")) : model.ownedBy ?? model.id}`;
          rows.push([view.details
            ? button(label, { ...next, page: "detail", model: model.id })
            : button(label, next, { type: view.routing ? "routing_model" : "model", model: model.id })]);
        }
        const navigation: Button[] = [];
        if (offset > 0) navigation.push(button("上一页", { ...view, offset: offset - PAGE_SIZE }));
        if (offset + PAGE_SIZE < models.length) navigation.push(button("下一页", { ...view, offset: offset + PAGE_SIZE }));
        if (navigation.length) rows.push(navigation);
        rows.push([button(view.favorites ? "全部模型" : "常用模型", { ...view, page: "models", offset: 0, details: false, favorites: !view.favorites }),
          { label: "刷新目录", value: { view: { ...view, offset: 0 }, refresh: true } }]);
        rows.push([button(view.details ? "🤖 返回选择" : "ℹ️ 详情与收藏", { ...view, details: !view.details, offset })]);
        break;
      }
      case "detail": {
        const model = s.catalog.find(item => item.id === view.model);
        if (!model) { text = "此模型已不在当前目录中，请刷新并重新选择。"; }
        else {
          text = `ℹ️ ${model.displayName}\n\nID：${model.id}\n供应商：${model.ownedBy ?? "未知"}\n\n上下文窗口：${model.contextWindow ?? "未知"}\n最大输出：${model.maxOutputTokens ?? "未知"}\n模态：${model.modalities?.join("、") ?? "未知"}\n推理：${model.reasoning === false ? "不支持" : model.reasoning ? "支持" : "未知"}\n等级：${model.reasoningLevels?.join("、") ?? "能力未提供"}`;
          rows.push([button("选择此模型", { ...view, page: "models", details: false }, { type: view.routing ? "routing_model" : "model", model: model.id })],
            [button(s.favorites.includes(model.id) ? "★ 移除常用" : "☆ 加入常用", view, { type: "favorite", model: model.id, enabled: !s.favorites.includes(model.id) })]);
        }
        rows.push([button("返回模型列表", { ...view, page: "models" })]);
        break;
      }
      case "thinking":
        text = `🧠 思考等级\n\n模型：${selected?.displayName ?? s.selectedModel ?? "未选择"}\n当前：${s.thinking ?? "未设置"}`;
        if (!selected) text += "\n请先选择可用模型。";
        else if (selected.reasoning === false) text += "\n此模型不支持推理，无需设置等级。";
        else if (!selected.reasoningLevels?.length) text += "\n目录未提供可调等级，不发送猜测的 effort。";
        else for (let index = 0; index < selected.reasoningLevels.length; index += 2) rows.push(selected.reasoningLevels.slice(index, index + 2).map(level => button(`${s.thinking === level ? "✓ " : ""}${level}`, view, { type: "thinking", level })));
        if (s.thinkingAdjusted) text += "\n能力已更新，原偏好不再支持，已调整为支持的等级。";
        break;
      case "works": {
        // Queue order is oldest first; show recent work before paginating.
        const works = s.works.toReversed();
        const offset = Math.max(0, view.offset ?? 0);
        text = `⏳ 工作列表\n\n${s.works.length ? `共 ${s.works.length} 项 · 点击查看进度与操作\n◽ 本轮结束仅表示处理结束，成果仍需核对。` : "暂无工作。"}`;
        const workIcons: Record<string, string> = { completed: "◽", cancelled: "🚫", paused: "⏸", running: "▶️", queued: "⌛" };
        for (const work of works.slice(offset, offset + PAGE_SIZE)) rows.push([button(`${workIcons[work.status] ?? "•"} ${work.summary}`.slice(0, 90), { page: "work", target: work.id })]);
        const navigation: Button[] = [];
        if (offset > 0) navigation.push(button("上一页", { ...view, offset: offset - PAGE_SIZE }));
        if (offset + PAGE_SIZE < s.works.length) navigation.push(button("下一页", { ...view, offset: offset + PAGE_SIZE }));
        if (navigation.length) rows.push(navigation);
        break;
      }
      case "work": {
        const work = s.works.find(item => item.id === view.target);
        if (!work) text = "此工作不属于当前会话或已不存在，未执行操作。";
        else {
          text = `工作详情\n${work.summary}\n目标：${work.id}\n状态：${statusName(work.status)}${work.reason ? `\n${work.reason}` : ""}${work.helperId ? `\n后台 helper：${work.helperId}` : ""}`;
          if (!["cancelled", "stopped", "completed"].includes(work.status)) rows.push([button("取消此工作", view, { type: "cancel", target: work.id, operationId: randomBytes(12).toString("hex") })]);
          if (["paused", "needs_confirmation"].includes(work.status)) rows.push([button("继续此工作", view, { type: "resume", target: work.id, operationId: randomBytes(12).toString("hex") })]);
        }
        rows.push([button("返回工作列表", { page: "works" })]);
        break;
      }
      case "cache": text = note ?? "缓存统计暂无数据。"; note = undefined; break;
      case "satiety":
        text = `🍜 饱食度\n\n${s.satiety.label} · ${Math.round(s.satiety.value)}/100\n48 小时从满值降至 0；每次投喂增加 25，最高 100。\n肚子饿也会认真办事，不需要投喂才能工作。`;
        rows.push([button("投喂 +25", view, { type: "feed", operationId: randomBytes(12).toString("hex") })]);
        break;
      case "settings":
        text = `⚙️ 设置\n\n主动表达：${frequencyNames[s.expressionFrequency]}\n安静档不主动发贴纸或点表情，明确要求时仍可使用。\n调整预览或管理会话；缓存统计在首页。`;
        for (const [frequency, label] of Object.entries(frequencyNames)) rows.push([button(`${s.expressionFrequency === frequency ? "✓ " : ""}${label}`, view,
          { type: "expression", frequency: frequency as keyof typeof frequencyNames, operationId: randomBytes(12).toString("hex") })]);
        rows.push([button(`✍️ 草稿预览：${s.drafts ? "开" : "关"}`, view, { type: "draft", enabled: !s.drafts })],
          [button("🗂 会话操作", { page: "session" })]);
        break;
      case "session":
        text = "会话操作\n换模型保留上下文和工作；暂停工作需明确继续。\n重置仅清除模型上下文，保留队列、工作、helper 和全部设置。";
        rows.push([button("继续暂停工作", view, { type: "resume", operationId: randomBytes(12).toString("hex") })],
          [button("重置上下文…", { page: "reset" })]);
        break;
      case "reset":
        text = "确认重置上下文？\n仅清除主模型上下文；保留排队与执行工作、helper、模型、思考偏好、常用模型和草稿设置。不会恢复暂停工作。\n忙时将在安全边界执行，确认不代表已完成。";
        rows.push([button("确认重置", { page: "session" }, { type: "reset", operationId: randomBytes(12).toString("hex") }), button("取消", { page: "session" })]);
        break;
    }
    if (failure) text += `\n${failure}`;
    if (note && ["home", "cache", "session", "work", "works", "satiety"].includes(view.page)) text += `\n${note}`;
    if (view.page === "session") rows.push([button("⚙️ 返回设置", { page: "settings" })]);
    if (view.page !== "home") rows.push([button("返回首页", home)]);
    const token = randomBytes(9).toString("base64url");
    const actions: ButtonAction[] = [];
    const keyboard = new InlineKeyboard();
    for (const [rowIndex, row] of rows.entries()) {
      if (rowIndex > 0) keyboard.row();
      for (const item of row) { keyboard.text(item.label, `cp:${token}:${actions.length.toString(36)}`); actions.push(item.value); }
    }
    const [title, ...lines] = text.slice(0, 3800).split("\n");
    const content = html(lines.join("\n"));
    const formatted = view.page === "cache" ? text.slice(0, 4000) : `<b>${html(title!)}</b>\n${view.page === "home"
      ? content.replace(/^(Status|Tokens|Cache|Context): (.*)$/gm, "<b>$1:</b> <code>$2</code>") : content}`;
    const parseMode = view.page === "cache" ? undefined : "HTML" as const;
    const messageId = ctx.callbackQuery?.message?.message_id;
    const reply = messageId === undefined
      ? await ctx.reply(formatted, { parse_mode: parseMode, reply_markup: keyboard })
      : await ctx.editMessageText(formatted, { parse_mode: parseMode, reply_markup: keyboard });
    const panelMessageId = messageId ?? (reply as { message_id: number }).message_id;
    // A new view replaces the buttons on this message, so superseded capabilities expire.
    const now = Date.now();
    for (const [key, panel] of panels) if (panel.expires < now || panel.messageId === panelMessageId) panels.delete(key);
    if (panels.size >= 200) panels.delete(panels.keys().next().value!);
    panels.set(token, { messageId: panelMessageId, expires: now + 30 * 60_000, actions, used: new Set() });
  }

  bot.on("callback_query:data", async ctx => {
    const match = /^cp:([\w-]+):([0-9a-z]+)$/.exec(ctx.callbackQuery.data);
    if (!validOwner(ctx)) { await ctx.answerCallbackQuery({ text: "仅主人私聊可以操作此会话。" }); return; }
    const panel = match ? panels.get(match[1]!) : undefined;
    const index = match ? Number.parseInt(match[2]!, 36) : -1;
    const entry = panel?.actions[index];
    if (!panel || !entry || panel.expires < Date.now() || panel.messageId !== ctx.callbackQuery.message?.message_id) {
      await ctx.answerCallbackQuery({ text: "此按钮已过期或不属于此消息，请发送 /start。" }); return;
    }
    if (entry.action && panel.used.has(index)) { await ctx.answerCallbackQuery({ text: "此按钮已使用，请查看最新状态。" }); return; }
    if (entry.action) panel.used.add(index);
    // Acknowledge before catalog I/O, helper control, or service mutations.
    await ctx.answerCallbackQuery({ text: "正在更新…" });
    try {
      const result = entry.action ? await app.control(conversationId, entry.action) : undefined;
      await render(ctx, entry.view, entry.refresh ? undefined : result?.snapshot, result?.text, entry.refresh);
    } catch (error) {
      for (const [key, stored] of panels) if (stored.messageId === panel.messageId) panels.delete(key);
      await ctx.editMessageText(`操作未完成：${error instanceof Error ? error.message : "请稍后重试"}。请发送 /start 查看当前状态。`)
        .catch(options.reportFailure);
    }
  });

  bot.on("message:text", async (ctx, next) => {
    if (!validOwner(ctx)) return next();
    const match = /^\/(start|model|thinking|work|kvcache|session|draft|reset|resume|stop|feed)(?:@([\w]+))?(?:\s+([\s\S]*))?$/.exec(ctx.message.text.trim());
    if (!match) return next();
    if (match[2] && match[2].toLowerCase() !== bot.botInfo.username.toLowerCase()) return;
    const messageId = ctx.message.message_id;
    const previous = commands.get(messageId);
    if (previous) { await previous; return; }
    const work = (async () => {
      const name = match[1]; const arg = match[3]?.trim();
      let view: View = home; let action: ControlAction | undefined; let refresh = false;
      if (name === "model") { view = { page: "models" }; if (arg) action = { type: "model", model: arg }; else refresh = true; }
      if (name === "thinking") { view = { page: "thinking" }; if (arg) action = { type: "thinking", level: arg }; }
      if (name === "work") view = { page: "works" };
      if (name === "feed") { if (arg) { await ctx.reply("用法：/feed（投喂一次，饱食度 +25）"); return; } view = { page: "satiety" }; action = { type: "feed", operationId: `telegram:${messageId}:feed` }; }
      if (name === "session") view = { page: "session" };
      if (name === "reset") view = { page: "reset" };
      if (name === "resume") { view = { page: "works" }; action = { type: "resume", ...(arg ? { batchId: arg } : {}), operationId: `telegram:${messageId}:resume` }; }
      if (name === "stop") { if (arg) { await ctx.reply("用法：/stop（暂停当前请求，保留进度）"); return; } action = {type:"stop",operationId:`telegram:${messageId}:stop`}; }
      if (name === "kvcache") { view = { page: "cache" }; if (arg) { await ctx.reply("用法：/kvcache（查看最近五轮）"); return; } action = { type: "cache" }; }
      if (name === "draft") { view = { page: "settings" }; const s = await app.controlSnapshot(conversationId); action = { type: "draft", enabled: arg === "on" ? true : arg === "off" ? false : !s.drafts }; }
      try {
        const result = action ? await app.control(conversationId, action.type === "cache" ? action : { ...action, operationId: `telegram:${messageId}:${name}` }) : undefined;
        await render(ctx, view, result?.snapshot, result?.text, refresh);
      } catch (error) { await ctx.reply(`操作未完成：${error instanceof Error ? error.message : "请稍后重试"}。请用 /model 选择当前 Magpie 目录中的完整模型 ID。`); }
    })();
    commands.set(messageId, work);
    if (commands.size > 500) commands.delete(commands.keys().next().value!);
    await work;
  });
}
