import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createIntentClassifier, type IntentRequest } from "../../src/assistant/intent.js";
import { modelEnvironment } from "../../src/agent/model-config.js";

// Run explicitly against an existing configured alias. Save no provider credentials.
const [output, alias] = process.argv.slice(2);
if (!output || !alias) throw new Error("Usage: routing-live.ts EXTERNAL_OUTPUT_DIRECTORY MODEL_ALIAS");
const directory = resolve(output);
await mkdir(directory,{recursive:true});
const configuration = modelEnvironment(process.env);
const classifier = createIntentClassifier(configuration,{model:alias});
const works = [
  {id:"report",summary:"生成本月销售报表",status:"running",inputId:"report-input"},
  {id:"chart",summary:"生成季度收入图表",status:"queued",inputId:"chart-input"},
];
const cases: Array<{name:string;request:IntentRequest;expected:Array<{kind:string;target?:string}>}> = [
  {name:"中文新请求",request:{input:{conversationId:"live",inputId:"new",text:"今天上海天气怎么样？"},works:[],recent:[]},expected:[{kind:"request"}]},
  {name:"近期指代",request:{input:{conversationId:"live",inputId:"refer",text:"刚才那个改成 CSV 格式"},works:[works[0]!],recent:[{role:"user",inputId:"report-input",text:"请生成本月销售报表"},{role:"assistant",inputId:"assistant:1",text:"正在生成本月销售报表。"}]},expected:[{kind:"supplement",target:"report"}]},
  {name:"跨无关消息补充",request:{input:{conversationId:"live",inputId:"amend",text:"销售报表改成 CSV，天气那个照常"},works,recent:[{role:"user",inputId:"report-input",text:"请生成本月销售报表"},{role:"user",inputId:"weather",text:"今天上海天气怎么样"}]},expected:[{kind:"supplement",target:"report"}]},
  {name:"明确取消",request:{input:{conversationId:"live",inputId:"cancel",text:"停止生成本月销售报表，保留已生成的文件"},works,recent:[]},expected:[{kind:"cancel",target:"report"}]},
  {name:"多目标歧义",request:{input:{conversationId:"live",inputId:"ambiguous",text:"那个先别做了"},works,recent:[]},expected:[{kind:"clarify"}]},
  {name:"复合动作",request:{input:{conversationId:"live",inputId:"compound",text:"取消季度收入图表，顺便告诉我明天北京的天气"},works,recent:[]},expected:[{kind:"cancel",target:"chart"},{kind:"request"}]},
];
const results: unknown[] = [];
for (const scenario of cases) {
  const started = Date.now();
  const result = await classifier.classify(scenario.request);
  const actual = result.actions.map(({kind,target})=>({kind,...(target?{target}:{})}));
  const passed = scenario.name === "跨无关消息补充" ? actual.some(action=>action.kind==="supplement"&&action.target==="report") && !actual.some(action=>action.kind==="cancel") : JSON.stringify(actual) === JSON.stringify(scenario.expected);
  results.push({scenario:scenario.name,request:scenario.request,expected:scenario.expected,actual:result,elapsedMs:Date.now()-started,passed});
  await writeFile(join(directory,"classifier-results.json"),JSON.stringify({at:new Date().toISOString(),alias,results},null,2));
  console.log(`${scenario.name}: ${passed?"PASS":"FAIL"} ${Date.now()-started}ms ${JSON.stringify(actual)}${result.reason?` ${result.reason}`:""}`);
}
if ((results as Array<{passed:boolean}>).some(result=>!result.passed)) process.exitCode=1;
