import {createHash} from "node:crypto";
import type {EntryRecord, SubmissionRecord} from "@earendil-works/pi-durable";
import type {MemorySource} from "./memory.js";
import type {PersistedInput, QueueInput, StoredBatch} from "./queue.js";

export type AkashaLearningInput = {
  sourceId:string; inputId:string; source:string; sequence:number; eventId?:string;
  targetId?:string; actionId?:string; submissionId:string; entryId:number;
  /** Actual saved query material, absent when it was never recorded. */
  query?:unknown;
};
export type AkashaLearningSample = {
  id:string; conversationId:string; batchId:string; answerEntryId:number; taskId:number;
  responseSourceId:string; inputSourceIds:string[]; inputs:AkashaLearningInput[];
  submissionIds:string[]; startedAt?:number; endedAt:number;
  feedback?:AkashaToolFeedback[];
};
/** Successful persisted tool evidence, retained even when forgetting excludes its target. */
export type AkashaToolFeedback = {
  action:"remember"|"forget"; targetSourceIds:string[];
  toolName:"memory_write"|"memory_forget"; toolCallId:string;
  callEntryId:number; resultEntryId:number;
};
export type AkashaLearningSkip = {
  id:string; conversationId:string; batchId:string; sourceIds:string[];
  submissionId?:string; reason:string;
};
export type AkashaLearningFacts = {samples:AkashaLearningSample[];skipped:AkashaLearningSkip[]};
export type AkashaLearningSteer = {
  key:string;input:QueueInput;targetBatch:string;submissionId?:string;actionId?:string;targetId?:string;
};
export type AkashaLearningAccess = {
  batch:StoredBatch;steers?:readonly AkashaLearningSteer[];
  submission(id:string):Promise<SubmissionRecord|undefined>;
  entry(id:number):Promise<EntryRecord|undefined>;
  task(id:number):Promise<{state:{status:string;outcome?:{status:string}};startedAt?:number;endedAt?:number}|undefined>;
  source(id:string):MemorySource|undefined;
  current(id:string):boolean;
  query?(sourceId:string):unknown;
  entries?(conversationId:number,minEntryId:number,maxEntryId:number):Promise<readonly EntryRecord[]>;
};

const identity=(parts:unknown[])=>createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const sourceIdentity=(conversationId:string,input:Pick<QueueInput,"inputId"|"source">)=>
  `source:${identity([conversationId,input.source??(conversationId.startsWith("telegram:")?"telegram":"cli"),input.inputId])}`;
type Candidate = {submissionId?:string;kind:"nailong.batch"|"nailong.steer";key:string;inputs:Array<QueueInput&{sequence:number;eventId?:string;actionId?:string}>};

/** Derive learning eligibility from committed Queue and Durable facts, without changing execution state. */
export async function collectAkashaLearning(access:AkashaLearningAccess):Promise<AkashaLearningFacts>{
  const {batch}=access;
  const result:AkashaLearningFacts={samples:[],skipped:[]};
  const mainInputs=batch.events.flatMap(event=>[event,...(event.supplements??[])]);
  const candidates:Candidate[]=[{submissionId:batch.submissionId,kind:"nailong.batch",key:batch.id,inputs:mainInputs}];
  for(const steer of access.steers??[]){
    if(steer.targetBatch!==batch.id)continue;
    const input=steer.input as QueueInput&Partial<PersistedInput>;
    candidates.push({submissionId:steer.submissionId,kind:"nailong.steer",key:steer.key,
      inputs:[{...input,targetId:steer.targetId??input.targetId,actionId:steer.actionId,sequence:input.sequence??Number.MAX_SAFE_INTEGER}]});
  }
  const skip=(candidate:Candidate,reason:string)=>{
    result.skipped.push({id:`learning-skip:${identity([batch.conversationId,batch.id,candidate.key])}`,
      conversationId:batch.conversationId,batchId:batch.id,
      sourceIds:[...new Set(candidate.inputs.map(input=>sourceIdentity(batch.conversationId,input)))],
      ...(candidate.submissionId?{submissionId:candidate.submissionId}:{}),reason});
  };
  const groups=new Map<number,AkashaLearningSample>();
  for(const candidate of candidates){
    if(batch.status!=="completed"){skip(candidate,`queue_${batch.status}`);continue;}
    if(!candidate.inputs.length||candidate.inputs.some(input=>input.kind==="command")){skip(candidate,"not_user_conversation");continue;}
    if(!candidate.submissionId){skip(candidate,"missing_submission");continue;}
    const submission=await access.submission(candidate.submissionId);
    if(!submission||submission.type!=="input"){skip(candidate,"missing_submission");continue;}
    if(submission.status!=="done"){skip(candidate,`submission_${submission.status}`);continue;}
    const [inputEntry,answer]=await Promise.all([access.entry(submission.entry),access.entry(submission.answer)]);
    const data=inputEntry?.data as {batchId?:string;inputId?:string;sourceIds?:unknown}|undefined;
    if(!inputEntry||inputEntry.kind!==candidate.kind||!Array.isArray(data?.sourceIds)||
      (candidate.kind==="nailong.batch"&&data.batchId!==batch.id)||
      (candidate.kind==="nailong.steer"&&data.inputId!==candidate.inputs[0]!.inputId)){
      skip(candidate,"missing_input_association");continue;
    }
    if(!answer||answer.conversationId!==inputEntry.conversationId||answer.byTaskId===undefined){skip(candidate,"missing_committed_answer");continue;}
    const response=answer.model?.find(message=>message.role==="assistant");
    if(!response||response.stopReason!=="stop"||response.content.some(part=>part.type==="toolCall")){
      skip(candidate,"incomplete_answer");continue;
    }
    const text=response.content.filter(part=>part.type==="text").map(part=>part.text).join("\n");
    if(!text.trim()){skip(candidate,"empty_answer");continue;}
    const task=await access.task(answer.byTaskId);
    if(task?.state.status!=="terminal"||task.state.outcome?.status!=="completed"){
      skip(candidate,"incomplete_answer_task");continue;
    }
    if(task.endedAt===undefined||!Number.isFinite(task.endedAt)){skip(candidate,"missing_end_time");continue;}
    const responseSourceId=sourceIdentity(batch.conversationId,{inputId:`assistant:${answer.byTaskId}`,source:"assistant"});
    const source=access.source(responseSourceId);
    if(!source||source.role!=="assistant"||source.conversationId!==batch.conversationId||source.text!==text){skip(candidate,"missing_response_source");continue;}
    if(!access.current(responseSourceId)){skip(candidate,"excluded_source");continue;}
    const inputs:AkashaLearningInput[]=[];
    let invalid=false;
    for(const input of candidate.inputs){
      const sourceId=sourceIdentity(batch.conversationId,input);
      const original=access.source(sourceId);
      if(!original||original.role!=="user"||original.conversationId!==batch.conversationId||
        original.text!==(input.userText??input.text)||!data!.sourceIds!.includes(sourceId)){
        invalid=true;break;
      }
      if(!access.current(sourceId)){invalid=true;break;}
      const query=access.query?.(sourceId);
      inputs.push({sourceId,inputId:input.inputId,source:original.source,sequence:input.sequence,
        eventId:input.eventId,targetId:input.targetId,actionId:input.actionId,
        submissionId:candidate.submissionId,entryId:inputEntry.id,...(query===undefined?{}:{query})});
    }
    if(invalid){skip(candidate,"invalid_or_excluded_input_source");continue;}
    let sample=groups.get(answer.id);
    if(!sample){
      sample={id:`learning:${identity([batch.conversationId,answer.id])}`,conversationId:batch.conversationId,batchId:batch.id,
        answerEntryId:answer.id,taskId:answer.byTaskId,responseSourceId,inputSourceIds:[],inputs:[],submissionIds:[],
        ...(task.startedAt===undefined?{}:{startedAt:task.startedAt}),endedAt:task.endedAt};
      groups.set(answer.id,sample);
    }
    sample.inputs.push(...inputs);
    if(!sample.submissionIds.includes(candidate.submissionId))sample.submissionIds.push(candidate.submissionId);
  }
  for(const sample of groups.values()){
    // The Queue already orders equal-sequence targets by their numeric ordinal.
    // Stable sorting keeps that real order, including action 2 before action 10.
    sample.inputs.sort((a,b)=>a.entryId-b.entryId||a.sequence-b.sequence);
    sample.inputs=sample.inputs.filter((input,index,inputs)=>inputs.findIndex(other=>other.sourceId===input.sourceId&&other.targetId===input.targetId&&other.actionId===input.actionId)===index);
    sample.inputSourceIds=[...new Set(sample.inputs.map(input=>input.sourceId))];
    if(access.entries){
      const first=await access.entry(sample.inputs[0]!.entryId);
      if(first)sample.feedback=collectFeedback(await access.entries(first.conversationId,first.id,sample.answerEntryId));
    }
    result.samples.push(sample);
  }
  result.samples.sort((a,b)=>a.endedAt-b.endedAt||a.answerEntryId-b.answerEntryId);
  return result;
}

function collectFeedback(entries:readonly EntryRecord[]):AkashaToolFeedback[]{
  const calls=new Map<string,{name:"memory_write"|"memory_forget";entryId:number}>();
  const feedback:AkashaToolFeedback[]=[];
  for(const entry of [...entries].sort((a,b)=>a.id-b.id))for(const message of entry.model??[]){
    if(message.role==="assistant")for(const part of message.content){
      if(part.type==="toolCall"&&(part.name==="memory_write"||part.name==="memory_forget"))calls.set(part.id,{name:part.name,entryId:entry.id});
    }
    if(message.role!=="toolResult")continue;
    const call=calls.get(message.toolCallId);
    if(!call||call.name!==message.toolName||call.entryId>=entry.id)continue;
    calls.delete(message.toolCallId);
    if(message.isError)continue;
    const text=message.content.filter(part=>part.type==="text").map(part=>part.text).join("\n");
    let value:unknown;try{value=JSON.parse(text);}catch{continue;}
    const receipt=(value as {akashaFeedback?:{action?:unknown;targetSourceIds?:unknown}}|null)?.akashaFeedback;
    const action=call.name==="memory_write"?"remember":"forget";
    if(receipt?.action!==action||!Array.isArray(receipt.targetSourceIds)||!receipt.targetSourceIds.every(id=>typeof id==="string"))continue;
    const targetSourceIds=[...new Set(receipt.targetSourceIds as string[])];
    if(targetSourceIds.length)feedback.push({action,targetSourceIds,toolName:call.name,toolCallId:message.toolCallId,callEntryId:call.entryId,resultEntryId:entry.id});
  }
  return feedback;
}
