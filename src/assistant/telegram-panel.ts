import { randomBytes } from "node:crypto";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import type { Assistant, ControlSnapshot, ControlAction } from "./runtime.js";

type Page = "home" | "models" | "thinking" | "works" | "work" | "cache" | "session" | "reset" | "detail";
type View = { page: Page; offset?: number; favorites?: boolean; model?: string; target?: string };
type ButtonAction = { view: View; action?: ControlAction; refresh?: boolean };
type Button = { label: string; value: ButtonAction };
const home: View = { page: "home" };
const PAGE_SIZE = 6;
const statusNames: Record<string, string> = { idle: "空闲", running: "执行中", waiting_model: "等待选择可用模型", paused: "已暂停", queued: "排队中", pending: "排队中", completed: "本轮已结束（目标成果仍需核对）", cancelled: "已取消后续安排", stopping: "停止中", stopped: "已核实停止", unknown: "待核实", background: "后台 helper", helper: "后台 helper", needs_confirmation: "待核实" };
const statusName = (value: string) => statusNames[value] ?? value;

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
    switch (view.page) {
      case "home":
        text = `会话控制面板\n${connection}\n状态：${statusName(s.status)} · 等待 ${s.waiting}\n期望模型：${setting(s.selectedModel, s.thinking)}\n实际请求：${setting(s.actual?.model, s.actual?.thinking)}${s.pending ? "\n待生效：下一次准备请求使用最新选择。" : ""}`;
        if (s.selectedModel && !s.selectedAvailable) text += "\n当前选择不可用，请重新选择；上下文与工作保留。";
        rows.push([{ label: "模型", value: { view: { page: "models" }, refresh: true } }]);
        if (selected?.reasoning !== false && (selected?.reasoning || selected?.reasoningLevels?.length)) rows.push([button("思考等级", { page: "thinking" })]);
        rows.push([button("工作列表", { page: "works" }), button("缓存统计", { page: "cache" }, { type: "cache" })],
          [button("会话操作", { page: "session" })],
          [button(`草稿预览：${s.drafts ? "开" : "关"}`, home, { type: "draft", enabled: !s.drafts })]);
        break;
      case "models": {
        const models = s.catalog.filter(model => !view.favorites || s.favorites.includes(model.id));
        const offset = Math.max(0, Math.min(view.offset ?? 0, Math.max(0, Math.ceil(models.length / PAGE_SIZE) - 1) * PAGE_SIZE));
        text = `模型 · ${view.favorites ? "常用" : "全部"}\n${connection}\n当前：${setting(s.selectedModel, s.thinking)}\n第 ${Math.floor(offset / PAGE_SIZE) + 1}/${Math.max(1, Math.ceil(models.length / PAGE_SIZE))} 页`;
        if (!models.length) text += view.favorites ? "\n暂无可用常用模型；到全部列表添加收藏。" : "\n目录为空；请在 Magpie 中启用模型后刷新。";
        for (const model of models.slice(offset, offset + PAGE_SIZE)) {
          const current = model.id === s.selectedModel ? "✓ " : "";
          const next = { ...view, offset };
          text += `\n${current}${model.displayName}${model.ownedBy ? ` · ${model.ownedBy}` : ""}\n${model.id}`;
          rows.push([button(`${current}${model.displayName}`.slice(0, 90), next, { type: "model", model: model.id }),
            button("详情", { page: "detail", model: model.id }),
            button(s.favorites.includes(model.id) ? "★" : "☆", next, { type: "favorite", model: model.id, enabled: !s.favorites.includes(model.id) })]);
        }
        const navigation: Button[] = [];
        if (offset > 0) navigation.push(button("上一页", { ...view, offset: offset - PAGE_SIZE }));
        if (offset + PAGE_SIZE < models.length) navigation.push(button("下一页", { ...view, offset: offset + PAGE_SIZE }));
        if (navigation.length) rows.push(navigation);
        rows.push([button(view.favorites ? "全部模型" : "常用模型", { page: "models", favorites: !view.favorites }),
          { label: "刷新目录", value: { view: { ...view, offset: 0 }, refresh: true } }]);
        break;
      }
      case "detail": {
        const model = s.catalog.find(item => item.id === view.model);
        if (!model) { text = "此模型已不在当前目录中，请刷新并重新选择。"; }
        else {
          text = `模型详情\n${model.displayName}\nID：${model.id}\n供应商：${model.ownedBy ?? "未知"}\n上下文窗口：${model.contextWindow ?? "未知"}\n最大输出：${model.maxOutputTokens ?? "未知"}\n模态：${model.modalities?.join("、") ?? "未知"}\n推理：${model.reasoning === false ? "不支持" : model.reasoning ? "支持" : "未知"}\n等级：${model.reasoningLevels?.join("、") ?? "能力未提供"}`;
          rows.push([button("选择此模型", { page: "models" }, { type: "model", model: model.id }),
            button(s.favorites.includes(model.id) ? "移除常用" : "加入常用", view, { type: "favorite", model: model.id, enabled: !s.favorites.includes(model.id) })]);
        }
        rows.push([button("返回模型列表", { page: "models" })]);
        break;
      }
      case "thinking":
        text = `思考等级\n模型：${s.selectedModel ?? "未选择"}\n当前：${s.thinking ?? "未设置"}`;
        if (!selected) text += "\n请先选择可用模型。";
        else if (selected.reasoning === false) text += "\n此模型不支持推理，无需设置等级。";
        else if (!selected.reasoningLevels?.length) text += "\n目录未提供可调等级，不发送猜测的 effort。";
        else for (const level of selected.reasoningLevels) rows.push([button(`${s.thinking === level ? "✓ " : ""}${level}`, view, { type: "thinking", level })]);
        if (s.thinkingAdjusted) text += "\n能力已更新，原偏好不再支持，已调整为支持的等级。";
        break;
      case "works": {
        const offset = Math.max(0, view.offset ?? 0);
        text = `工作列表\n${s.works.length ? "每项对应独立工作目标。" : "暂无工作。"}`;
        for (const work of s.works.slice(offset, offset + PAGE_SIZE)) rows.push([button(`${statusName(work.status)} · ${work.summary}`.slice(0, 90), { page: "work", target: work.id })]);
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
    if (note) text += `\n${note}`;
    if (view.page !== "home") rows.push([button("返回首页", home)]);
    const token = randomBytes(9).toString("base64url");
    const actions: ButtonAction[] = [];
    const keyboard = new InlineKeyboard();
    for (const row of rows) {
      for (const item of row) { keyboard.text(item.label, `cp:${token}:${actions.length.toString(36)}`); actions.push(item.value); }
      keyboard.row();
    }
    const reply = await ctx.reply(text.slice(0, 4000), { reply_markup: keyboard });
    // Keep old messages usable for a short period, but each mutation is single-use.
    const now = Date.now();
    for (const [key, panel] of panels) if (panel.expires < now) panels.delete(key);
    if (panels.size >= 200) panels.delete(panels.keys().next().value!);
    panels.set(token, { messageId: reply.message_id, expires: now + 30 * 60_000, actions, used: new Set() });
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
      await ctx.reply(`操作未完成：${error instanceof Error ? error.message : "请稍后重试"}。请发送 /start 查看当前状态。`);
    }
  });

  bot.on("message:text", async (ctx, next) => {
    if (!validOwner(ctx)) return next();
    const match = /^\/(start|model|thinking|work|kvcache|session|draft|reset|resume)(?:@([\w]+))?(?:\s+([\s\S]*))?$/.exec(ctx.message.text.trim());
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
      if (name === "session") view = { page: "session" };
      if (name === "reset") view = { page: "reset" };
      if (name === "resume") { view = { page: "works" }; action = { type: "resume", ...(arg ? { batchId: arg } : {}), operationId: `telegram:${messageId}:resume` }; }
      if (name === "kvcache") { view = { page: "cache" }; if (arg) { await ctx.reply("用法：/kvcache（查看最近五轮）"); return; } action = { type: "cache" }; }
      if (name === "draft") { const s = await app.controlSnapshot(conversationId); action = { type: "draft", enabled: arg === "on" ? true : arg === "off" ? false : !s.drafts }; }
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
