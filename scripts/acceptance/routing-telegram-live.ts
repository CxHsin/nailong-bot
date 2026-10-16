import { mkdir, appendFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Bot } from "grammy";
import { createAssistant } from "../../src/assistant/runtime.js";
import { connectTelegram } from "../../src/assistant/telegram.js";
import { modelEnvironment } from "../../src/agent/model-config.js";
import { downloadTelegramPhoto } from "../../src/telegram/telegram-input.js";
import { Type } from "typebox";

// Explicit live entry; starting it takes over polling for the configured owner's test session.
const [destination, model] = process.argv.slice(2);
if (!destination || !model) throw new Error("Usage: routing-telegram-live.ts EXTERNAL_OUTPUT_DIRECTORY CLASSIFIER_ALIAS");
const directory = resolve(destination);
await mkdir(directory,{recursive:true});
const token = process.env.AGENT_TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN;
const ownerId = Number(process.env.AGENT_TELEGRAM_USER_ID ?? process.env.TELEGRAM_USER_ID);
if (!token || !Number.isSafeInteger(ownerId)) throw new Error("Telegram owner configuration missing");
const log = (file:string,value:unknown) => appendFile(join(directory,file),JSON.stringify({at:new Date().toISOString(),...value as object})+'\n');
const app = await createAssistant({cwd:directory,dataDir:join(directory,'data'),modelConfiguration:modelEnvironment(process.env),intent:{model},
  prompt:`本次只做主人明确发来的 ROUTE215 受控验收。简洁中文回复。实际 Windows 工作目录是 ${directory.replaceAll('\\','/')}。文件一律使用相对文件名（report.csv 等）调用 write 和 send_file；禁止调用 bash，禁止使用 /tmp 路径或搜索文件系统。生成报表等文件时先调用 acceptance_hold 等待输入，再使用 write 把成果保存在当前工作目录，若补充更改格式则按最新要求。用 send_file 交付请求的文件。遵守路由材料中的目标范围，复用已确认效果；同条已确认控制动作不重做。不得启动 helper、访问其他项目、安装软件或向其他收件人发送内容。图片按实际图片回答，不猜造。`,
  onRequestMetrics:metric=>{void log('requests.jsonl',metric);},
  tools:[{name:'acceptance_hold',label:'Wait for live routing input',description:'Before generating an acceptance report, wait 20 seconds so the owner can supplement the current work.',parameters:Type.Object({}),
    async execute(_id,_args,signal){await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,20000);signal?.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('Acceptance wait cancelled'));},{once:true});});return {content:[{type:'text' as const,text:'等待边界结束；核对当前补充后继续。'}],details:{}};}}],reportFailure:error=>{void log('failures.jsonl',{error:String(error)});}});
app.subscribe(output=>log('outputs.jsonl',output));
const bot = new Bot(token);
await bot.init();
const webhook = await bot.api.getWebhookInfo();
if (webhook.url || webhook.pending_update_count) {await app.close();throw new Error('Existing webhook or pending updates; preserve production state and inspect before live polling');}
bot.use(async(ctx,next)=>{if(ctx.from?.id===ownerId)await log('inputs.jsonl',{message:ctx.message});await next();await log('routing.jsonl',app.routingStatus(`telegram:private:${ownerId}`));});
const channel = await connectTelegram({app,bot,ownerId,dataDir:directory,download:id=>downloadTelegramPhoto(bot,token,id),reportFailure:error=>{void log('failures.jsonl',{error:String(error)});}});
let closing = false;
async function close(){if(closing)return;closing=true;clearInterval(stopCheck);await bot.stop();await channel.close();await app.close();}
const stopCheck=setInterval(()=>{void readFile(join(directory,'STOP')).then(()=>close(),()=>{});},1000);
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
console.log(`READY @${bot.botInfo.username}; evidence ${directory}`);
await bot.start({allowed_updates:['message'],onStart:async()=>{
  const receipt=await bot.api.sendMessage(ownerId,'ROUTE215 测试已启动。请先单独发送：ROUTE215 生成一份两行销售报表，先等待再写 report.md，并把文件发给我\n然后另发一条：刚才的销售报表改成 CSV，文件名 report.csv\n收到文件后回复结果消息：只保留金额列。最后发一张无说明文字的图片。');
  await log('startup.jsonl',{messageId:receipt.message_id,status:'sent'});
}});
