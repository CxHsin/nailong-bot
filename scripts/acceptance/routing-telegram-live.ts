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
const bot = new Bot(token);
await bot.init();
const webhook = await bot.api.getWebhookInfo();
if (webhook.url || webhook.pending_update_count) throw new Error('Existing webhook or pending updates; preserve production state and inspect before live polling');
const app = await createAssistant({cwd:directory,dataDir:join(directory,'data'),modelConfiguration:modelEnvironment(process.env),intent:{model},
  prompt:`本次只做主人明确发来的 ROUTE215 受控验收。简洁中文回复。实际 Windows 工作目录是 ${directory.replaceAll('\\','/')}。文件一律使用相对文件名（report.csv 等）调用 write 和 send_file；禁止调用 bash，禁止使用 /tmp 路径或搜索文件系统。主人首次要求生成报表时，先且仅调用一次 acceptance_hold 等待补充；后续修改和图片不再等待。工具结束后核对已消费的最新补充，再使用 write 保存成果，格式与文件名按最新要求。用 send_file 交付请求的文件。遵守路由材料中的目标范围，复用已确认效果；同条已确认控制动作不重做。不得启动 helper、访问其他项目、安装软件或向其他收件人发送内容。收到图片且没有文字时，简洁描述图中实际内容和可见文字，不假定它是对报表的修改。`,
  onRequestMetrics:metric=>{void log('requests.jsonl',metric);},
  tools:[{name:'acceptance_hold',label:'Wait for live routing input',description:'Before the first acceptance report, hold its actual tool boundary for up to 90 seconds so the owner can supplement while it runs.',parameters:Type.Object({}),
    async execute(callId,_args,signal){
      await log('boundaries.jsonl',{callId,state:'entered'});
      const notice=await bot.api.sendMessage(ownerId,'ROUTE215：报表工具正在等待，尚未结束。现在请单独发送这一句：刚才的销售报表改成 CSV，文件名 live-report.csv。');
      await log('boundaries.jsonl',{callId,state:'notice_sent',messageId:notice.message_id});
      await new Promise<void>((resolve,reject)=>{
        let settled=false;
        const finish=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(release);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
        const abort=()=>finish(new Error('Acceptance wait cancelled'));
        const timer=setTimeout(()=>finish(),90000);
        const release=setInterval(()=>{void readFile(join(directory,'RELEASE')).then(()=>finish(),()=>{});},500);
        signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      });
      await log('boundaries.jsonl',{callId,state:'exited'});
      return {content:[{type:'text' as const,text:'等待边界结束；先核对在此期间到达的最新补充再生成报表。'}],details:{}};
    }}],reportFailure:error=>{void log('failures.jsonl',{error:String(error)});}});
app.subscribe(output=>log('outputs.jsonl',output));
bot.use(async(ctx,next)=>{if(ctx.from?.id===ownerId)await log('inputs.jsonl',{message:ctx.message});await next();await log('routing.jsonl',app.routingStatus(`telegram:private:${ownerId}`));});
const channel = await connectTelegram({app,bot,ownerId,dataDir:directory,download:async id=>{
  const image=await downloadTelegramPhoto(bot,token,id);
  await log('photos.jsonl',{fileId:id,mimeType:image.mimeType,bytes:Buffer.from(image.data,'base64').length});
  return image;
},reportFailure:error=>{void log('failures.jsonl',{error:String(error)});}});
let closing = false;
async function close(){if(closing)return;closing=true;clearInterval(stopCheck);clearInterval(statusCheck);await bot.stop();await channel.close();await app.close();}
const stopCheck=setInterval(()=>{void readFile(join(directory,'STOP')).then(()=>close(),()=>{});},1000);
let inspecting=false;
const statusCheck=setInterval(()=>{if(inspecting)return;inspecting=true;void log('status.jsonl',app.routingStatus(`telegram:private:${ownerId}`)).finally(()=>{inspecting=false;});},1000);
stopCheck.unref();statusCheck.unref();
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
console.log(`READY @${bot.botInfo.username}; evidence ${directory}`);
await bot.start({allowed_updates:['message'],onStart:async()=>{
  const receipt=await bot.api.sendMessage(ownerId,'ROUTE215 继续真实测试。先只发送这一句：生成一份两行销售报表，先等待，再写 live-report.md，并把文件发给我。\n等我提示“报表工具正在等待”后，再单独发补充句，具体文字届时给你。报表完成后，发一张不带说明文字的普通测试图片。');
  await log('startup.jsonl',{messageId:receipt.message_id,status:'sent'});
}});
