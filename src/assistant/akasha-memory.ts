import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {EmbeddingError, type EmbeddingService, type EmbeddingSpace} from "./embedding.js";
import type {MemorySource} from "./memory.js";
import {SourceFeaturePool} from "./akasha/sources.js";
import {LEXICAL_VERSION} from "./akasha/lexical.js";
import {tokenize} from "./akasha/lexical.js";
import {MemoryCycle,serializeTicket,restoreTicket, type TicketSnapshot} from "./akasha/cycle.js";
import {emptyFeedback, type Turn, type TurnFeedback} from "./akasha/model.js";
import type {AkashaLearningFacts, AkashaLearningSample} from "./akasha-learning.js";

type Prepared=ReturnType<EmbeddingService["prepare"]>;
type Vector={dense:number[];space:EmbeddingSpace};
type Row={payload:string};
const fingerprint=(text:string)=>createHash("sha256").update(text).digest("hex");

/** A learned experience owns its message members; a raw source can stand alone. */
export type AkashaRecallHit={id:string;lane:"direct"|"completion";primarySourceId:string;sourceIds:string[];
  score:number;sources:string[];basinIds:string[]};

/** Derived semantic state belongs to the current memory namespace, never to execution facts. */
export class AkashaMemory {
  private readonly controller=new AbortController();
  private readonly jobs=new Map<string,Promise<Vector>>();
  private timer?:NodeJS.Timeout;
  private worker?:Promise<void>;
  private stopped=false;
  private requested=false;
  private observedConfig?:string;
  private backoff=100;
  private requestOrder=0;
  private lastTotal=0;
  constructor(private readonly db:DatabaseSync,private readonly embedding:EmbeddingService,
    private readonly sources:()=>MemorySource[],private readonly current:(id:string)=>boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS akasha_spaces(id TEXT PRIMARY KEY,config TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS akasha_vectors(space TEXT NOT NULL,source TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(space,source));
      CREATE INDEX IF NOT EXISTS akasha_vector_fingerprints ON akasha_vectors(space,fingerprint);
      CREATE TABLE IF NOT EXISTS akasha_space_heads(config TEXT PRIMARY KEY,id TEXT NOT NULL,epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS akasha_samples(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS akasha_learning_skips(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS akasha_graphs(space TEXT NOT NULL,scope TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(space,scope));`);
    this.requestOrder=Number((db.prepare("SELECT MAX(epoch) AS epoch FROM akasha_space_heads").get() as {epoch:number|null}).epoch??0);
    this.refresh();
  }
  private originals(){return this.sources().filter(source=>source.role!=="config"&&source.text.trim());}
  private space(prepared:Prepared):EmbeddingSpace|undefined {
    const row=this.db.prepare("SELECT s.payload FROM akasha_space_heads h JOIN akasha_spaces s ON s.id=h.id WHERE h.config=?").get(prepared.fingerprint) as Row|undefined;
    return row&&JSON.parse(row.payload) as EmbeddingSpace;
  }
  private cached(space:EmbeddingSpace,text:string):number[]|undefined {
    const row=this.db.prepare("SELECT payload FROM akasha_vectors WHERE space=? AND fingerprint=? LIMIT 1").get(space.id,fingerprint(text)) as Row|undefined;
    return row&&JSON.parse(row.payload) as number[];
  }
  private indexed(space:EmbeddingSpace,source:MemorySource){
    return !!this.db.prepare("SELECT 1 FROM akasha_vectors WHERE space=? AND source=? AND fingerprint=?").get(space.id,source.id,fingerprint(source.text));
  }
  private commit(source:MemorySource,value:Vector,prepared:Prepared){
    if(this.stopped||!this.current(source.id))return;
    try {if(this.embedding.prepare().fingerprint!==prepared.fingerprint)return;}catch{return;}
    if(this.space(prepared)?.id!==value.space.id)return;
    this.db.prepare("INSERT OR REPLACE INTO akasha_vectors VALUES(?,?,?,?)").run(value.space.id,source.id,fingerprint(source.text),JSON.stringify(value.dense));
  }
  private async vectors(prepared:Prepared,texts:readonly string[]):Promise<Vector[]> {
    if(this.stopped)throw new EmbeddingError("cancelled","记忆服务正在关闭。");
    const space=this.space(prepared);
    const pending:Promise<Vector>[]=[];
    const missing=new Map<string,{text:string;indices:number[]}>();
    for(const [index,text] of texts.entries()){
      const cached=space&&this.cached(space,text);
      if(cached){pending[index]=Promise.resolve({dense:cached,space});continue;}
      const key=`${prepared.fingerprint}:${fingerprint(text)}`;
      const job=this.jobs.get(key);
      if(job){pending[index]=job;continue;}
      const entry=missing.get(key);
      if(entry)entry.indices.push(index);else missing.set(key,{text,indices:[index]});
    }
    if(missing.size){
      const entries=[...missing];
      const order=++this.requestOrder;
      const request=prepared.embed(entries.map(([,entry])=>entry.text),{signal:this.controller.signal}).then(result=>{
        const space={...result.space,id:fingerprint(JSON.stringify([result.space.id,LEXICAL_VERSION]))};
        if(!this.stopped){
          this.db.prepare("INSERT OR IGNORE INTO akasha_spaces VALUES(?,?,?)").run(space.id,prepared.fingerprint,JSON.stringify(space));
          // A response started before the dimension change cannot move the active head backwards.
          this.db.prepare("INSERT INTO akasha_space_heads VALUES(?,?,?) ON CONFLICT(config) DO UPDATE SET id=excluded.id,epoch=excluded.epoch WHERE excluded.epoch>=akasha_space_heads.epoch").run(prepared.fingerprint,space.id,order);
        }
        return {...result,space};
      });
      for(const [index,[key,entry]] of entries.entries()){
        const job=request.then(result=>({dense:result.vectors[index]!,space:result.space}));
        this.jobs.set(key,job);
        void job.then(()=>this.jobs.delete(key),()=>this.jobs.delete(key));
        for(const target of entry.indices)pending[target]=job;
      }
    }
    return Promise.all(pending);
  }
  recordFacts(facts:AkashaLearningFacts){
    if(this.stopped)return;
    this.db.exec("BEGIN IMMEDIATE");
    try{
      for(const sample of facts.samples)this.db.prepare("INSERT OR REPLACE INTO akasha_samples VALUES(?,?)").run(sample.id,JSON.stringify(sample));
      for(const skip of facts.skipped)this.db.prepare("INSERT OR REPLACE INTO akasha_learning_skips VALUES(?,?)").run(skip.id,JSON.stringify(skip));
      this.db.exec("COMMIT");
    }catch(error){this.db.exec("ROLLBACK");throw error;}
    this.wake();
  }
  private samples(){return (this.db.prepare("SELECT payload FROM akasha_samples").all() as Row[]).map(row=>JSON.parse(row.payload) as AkashaLearningSample)
    .sort((a,b)=>a.endedAt-b.endedAt||Buffer.compare(Buffer.from(a.conversationId),Buffer.from(b.conversationId))||a.answerEntryId-b.answerEntryId||Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)));}
  private auditUnassociated(sources:MemorySource[]){
    const covered=new Set(this.samples().flatMap(sample=>[...sample.inputSourceIds,sample.responseSourceId]));
    for(const row of this.db.prepare("SELECT payload FROM akasha_learning_skips").all() as Row[]){
      const skip=JSON.parse(row.payload) as {id:string;sourceIds:string[];reason:string};
      if(skip.reason!=="missing_queue_association")for(const id of skip.sourceIds)covered.add(id);
    }
    for(const source of sources.filter(source=>source.role==="user")){
      const id=`learning-skip:${source.id}`;
      if(covered.has(source.id)){this.db.prepare("DELETE FROM akasha_learning_skips WHERE id=?").run(id);continue;}
      this.db.prepare("INSERT OR IGNORE INTO akasha_learning_skips VALUES(?,?)").run(id,JSON.stringify({id,conversationId:source.conversationId,sourceIds:[source.id],reason:"missing_queue_association"}));
    }
  }
  /** Rebuild from legal evidence when forgetting or a changed fact invalidates the saved prefix. */
  private graph(space:EmbeddingSpace,project?:string){
    const originals=new Map(this.originals().map(source=>[source.id,source]));
    const eligible=this.samples().filter(sample=>[...sample.inputSourceIds,sample.responseSourceId].every(id=>{
      const source=originals.get(id);return !!source&&this.current(id)&&(!source.project||source.project===project);
    }));
    const ready:AkashaLearningSample[]=[];
    for(const sample of eligible){if(![...sample.inputSourceIds,sample.responseSourceId].every(id=>this.cached(space,originals.get(id)!.text)))break;ready.push(sample);}
    const signatures=ready.map(sample=>fingerprint(JSON.stringify(sample)));
    const row=this.db.prepare("SELECT payload FROM akasha_graphs WHERE space=? AND scope=?").get(space.id,project??"") as Row|undefined;
    const saved=row&&JSON.parse(row.payload) as {signatures:string[];snapshot:ReturnType<MemoryCycle["serialize"]>};
    const prefix=saved&&saved.signatures.length<=signatures.length&&saved.signatures.every((value,index)=>value===signatures[index]);
    const cycle=prefix?MemoryCycle.restore(saved.snapshot):new MemoryCycle();
    const memberships=new Map<string,Set<number>>();
    const addMembers=(sample:AkashaLearningSample,node:number)=>{
      for(const id of [...sample.inputSourceIds,sample.responseSourceId]){
        const nodes=memberships.get(id)??new Set<number>();nodes.add(node);memberships.set(id,nodes);
      }
    };
    for(const [node,sample] of ready.slice(0,cycle.state_version).entries())addMembers(sample,node);
    let changed=!prefix;
    for(const sample of ready.slice(prefix?saved.signatures.length:0,(prefix?saved.signatures.length:0)+8)){
      const inputs=sample.inputSourceIds.map(id=>originals.get(id)!);const response=originals.get(sample.responseSourceId)!;
      const text=inputs.map(source=>source.text).join("\n");
      const user=new Array<number>(space.dimensions).fill(0);
      for(const source of inputs){const weight=Array.from(source.text).length;const dense=this.cached(space,source.text)!;for(let i=0;i<user.length;i++)user[i]!+=dense[i]!*weight;}
      let norm=0;for(const value of user)norm=Math.hypot(norm,value);
      const started=sample.startedAt===undefined?inputs[0]!.at:new Date(sample.startedAt).toISOString();
      const previous=cycle.turns.at(-1);
      const turn:Turn={node_id:cycle.state_version,turn_id:sample.inputSourceIds.length===1?sample.inputs[0]!.inputId:sample.id,session_key:sample.conversationId,user_seq:Math.min(...sample.inputs.map(input=>input.sequence)),
        user_message_id:sample.inputSourceIds.join(","),assistant_message_id:sample.responseSourceId,started_at:started,committed_at:new Date(sample.endedAt).toISOString(),
        user_text:text,assistant_text:response.text,user_dense:norm?Float32Array.from(user,value=>value/norm):null,assistant_dense:Float32Array.from(this.cached(space,response.text)!),
        user_terms:tokenize(text),assistant_terms:tokenize(response.text),inter_gap_seconds:previous?.session_key===sample.conversationId?Math.max(0,(Date.parse(started)-Date.parse(previous.committed_at))/1000):null,
        feedback:resolveFeedback(sample,cycle.state_version,memberships)};
      const query=sample.inputSourceIds.length===1?sample.inputs[0]?.query as {space?:string;scope?:string;ticket?:TicketSnapshot;graphBasis?:string}|undefined:undefined;
      // Only a matching actual single-input query can supply its frozen ticket.
      // Historical/grouped retrieval is recomputed by the core; tool feedback
      // comes only from the separate successful persisted receipts above.
      const basis=fingerprint(JSON.stringify(signatures.slice(0,cycle.state_version)));
      const ticket=query?.space===space.id&&query.scope===(project??"")&&query.graphBasis===basis&&query.ticket?restoreTicket(query.ticket):null;
      cycle.commit(turn,ticket);addMembers(sample,turn.node_id);changed=true;
    }
    if(changed)this.db.prepare("INSERT OR REPLACE INTO akasha_graphs VALUES(?,?,?)").run(space.id,project??"",JSON.stringify({signatures:signatures.slice(0,cycle.turns.length),snapshot:cycle.serialize()}));
    return {cycle,samples:ready.slice(0,cycle.turns.length),basis:fingerprint(JSON.stringify(signatures.slice(0,cycle.turns.length))),pending:cycle.turns.length<ready.length};
  }
  private learn(space:EmbeddingSpace){
    const projects=[...new Set(this.originals().map(source=>source.project))];
    let learned=0,pending=false;for(const project of projects){const graph=this.graph(space,project);learned+=graph.samples.length;pending ||=graph.pending;}
    return {learned,pending};
  }
  /** Configuration refresh and new originals wake the same bounded consumer. */
  refresh(){
    if(this.stopped)return;
    let config:string|undefined;try{config=this.embedding.prepare().fingerprint;}catch{}
    if(config!==this.observedConfig){this.observedConfig=config;this.backoff=100;if(this.timer){clearTimeout(this.timer);this.timer=undefined;}}
    this.wake();
  }
  wake(){
    if(this.stopped)return;
    this.requested=true;
    if(this.worker||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=undefined;this.requested=false;
      const pending=this.drain();this.worker=pending;
      void pending.then(()=>{this.worker=undefined;if(this.requested)this.wake();},()=>{
        this.worker=undefined;
        if(!this.stopped){this.embedding.setProgress({status:"degraded",total:this.lastTotal,completed:0,failed:0,reason:"记忆图准备暂不可用，正在重试。"});this.scheduleRetry();}
      });
    },0);this.timer.unref();
  }
  private scheduleRetry(){
    if(this.stopped||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=undefined;this.wake();},this.backoff);this.timer.unref();
    this.backoff=Math.min(30_000,this.backoff*2);
  }
  private async drain(){
    while(!this.stopped){
      const sources=this.originals();let prepared:Prepared;
      this.lastTotal=sources.length;
      this.auditUnassociated(sources);
      try{prepared=this.embedding.prepare();}catch(error){
        this.embedding.setProgress({status:sources.length?"degraded":"not_started",total:sources.length,completed:0,failed:0,reason:sources.length?(error instanceof EmbeddingError?error.message:"Embedding 未就绪。"):undefined});
        if(sources.length)this.scheduleRetry();return;
      }
      const space=this.space(prepared);
      const missing=sources.filter(source=>!space||!this.indexed(space,source));
      const learning=space?this.learn(space):{learned:0,pending:false};
      this.embedding.setProgress({status:missing.length||learning.pending?"preparing":sources.length?"ready":"not_started",total:sources.length,completed:sources.length-missing.length,failed:0,learned:learning.learned});
      if(!missing.length){if(learning.pending){await new Promise<void>(resolve=>setImmediate(resolve));continue;}return;}
      const batch=missing.slice(0,8);
      try{
        const vectors=await this.vectors(prepared,batch.map(source=>source.text));
        if(this.stopped)return;
        this.db.exec("BEGIN IMMEDIATE");
        try{for(const [index,source] of batch.entries())this.commit(source,vectors[index]!,prepared);this.db.exec("COMMIT");}catch(error){this.db.exec("ROLLBACK");throw error;}
        this.backoff=100;
      }catch(error){
        if(this.stopped)return;
        this.embedding.setProgress({status:"degraded",total:sources.length,completed:sources.length-missing.length,failed:batch.length,reason:error instanceof EmbeddingError?error.message:"记忆准备暂不可用。"});
        this.scheduleRetry();return;
      }
      // Let foreground controls and ordinary input progress between committed batches.
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
  }
  async query(text:string,project?:string,skip:readonly string[]=[],limit=8,identity?:Pick<MemorySource,"conversationId"|"inputId"|"at">){
    const prepared=this.embedding.prepare();
    let timeout:NodeJS.Timeout|undefined;
    try{
      const [cue]=await Promise.race([this.vectors(prepared,[text]),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new EmbeddingError("timeout","记忆检索超时，当前使用本地降级。")),prepared.timeoutMs);})]);
      if(this.stopped)throw new EmbeddingError("cancelled","记忆服务正在关闭。");
      const sources=this.originals().filter(source=>(!source.project||source.project===project)&&!skip.includes(source.id)&&this.current(source.id));
      const documents=sources.map(source=>({id:source.id,text:source.text,dense:this.cached(cue!.space,source.text)??null}));
      const directSources=new SourceFeaturePool(documents).query(text,cue!.dense,documents.length);
      const {cycle,samples,basis}=this.graph(cue!.space,project);
      const started=identity?.at??new Date().toISOString();const previous=cycle.turns.at(-1);
      const ticket=cycle.retrieve({node_id:cycle.state_version,turn_id:identity?.inputId??"active-query",session_key:identity?.conversationId??"active-query",user_seq:cycle.state_version,user_message_id:identity?.inputId??"active-query",assistant_message_id:"",started_at:started,committed_at:"",
        user_text:text,assistant_text:"",user_dense:Float32Array.from(cue!.dense),assistant_dense:null,user_terms:tokenize(text),assistant_terms:[],
        inter_gap_seconds:identity&&previous?.session_key===identity.conversationId?Math.max(0,(Date.parse(started)-Date.parse(previous.committed_at))/1000):null,feedback:emptyFeedback()});
      const available=new Map(sources.map(source=>[source.id,source]));
      const memberSamples=new Map<string,AkashaLearningSample[]>();
      for(const sample of samples)for(const id of [...sample.inputSourceIds,sample.responseSourceId]){
        const memberships=memberSamples.get(id)??[];memberships.push(sample);memberSamples.set(id,memberships);
      }
      const members=(ids:string[])=>[...new Set(ids)].filter(id=>available.has(id));
      const direct=new Map<string,AkashaRecallHit>();
      for(const hit of directSources){
        const source=available.get(hit.id)!;
        const memberships=memberSamples.get(hit.id)??[];
        if(memberships.length){
          for(const sample of memberships)if(!direct.has(sample.id))direct.set(sample.id,{id:sample.id,lane:"direct",primarySourceId:hit.id,
            sourceIds:members([hit.id,...sample.inputSourceIds,sample.responseSourceId]),score:hit.score,sources:["direct_feature"],basinIds:[]});
        }else{
          const parents=(source.parents??[]).filter(id=>available.get(id)?.role==="user");
          direct.set(hit.id,{id:hit.id,lane:"direct",primarySourceId:hit.id,sourceIds:members([hit.id,...parents]),score:hit.score,sources:["direct_feature"],basinIds:[]});
        }
      }
      const completion:AkashaRecallHit[]=[];
      for(const item of ticket.completion.items){
        const sample=samples[item.node_id];if(!sample)continue;
        const sourceIds=members([...sample.inputSourceIds,sample.responseSourceId]);if(!sourceIds.length)continue;
        completion.push({id:sample.id,lane:"completion",primarySourceId:available.has(sample.responseSourceId)?sample.responseSourceId:sourceIds[0]!,
          sourceIds,score:item.score,sources:item.sources,basinIds:item.basin_ids});
      }
      // Match the upstream host's two-lane contract. Limits count experiences,
      // not individual input/answer messages; neither lane can consume the other.
      const maximum=Math.max(0,Math.floor(limit));
      const selectedDirect=[...direct.values()].slice(0,Math.min(5,maximum));
      const directIds=new Set(selectedDirect.map(hit=>hit.id));
      const displayOrder=new Map(samples.map((sample,index)=>[sample.id,{at:cycle.turns[index]!.started_at,id:cycle.turns[index]!.turn_id}]));
      const newest=(a:AkashaRecallHit,b:AkashaRecallHit)=>{
        const first=displayOrder.get(a.id)??{at:available.get(a.primarySourceId)!.at,id:available.get(a.primarySourceId)!.inputId};
        const second=displayOrder.get(b.id)??{at:available.get(b.primarySourceId)!.at,id:available.get(b.primarySourceId)!.inputId};
        return Date.parse(second.at)-Date.parse(first.at)||Buffer.compare(Buffer.from(second.id),Buffer.from(first.id));
      };
      const hits=[...selectedDirect.sort(newest),...completion.filter(hit=>!directIds.has(hit.id)).slice(0,maximum).sort(newest)];
      const total=new Set([...direct.keys(),...completion.map(hit=>hit.id)]).size;
      this.wake();
      return {space:cue!.space.id,scope:project??"",ticket:serializeTicket(ticket),graphBasis:basis,retrievalVersion:cycle.state_version,preparing:documents.some(document=>document.dense===null),
        hits,total,availableSources:sources.length,sourceIds:[...new Set(hits.flatMap(hit=>hit.sourceIds))],status:"ready" as const};
    }finally{if(timeout)clearTimeout(timeout);}
  }
  async close(){
    if(this.stopped)return;this.stopped=true;if(this.timer)clearTimeout(this.timer);this.controller.abort();
    await Promise.allSettled([...(this.worker?[this.worker]:[]),...this.jobs.values()]);
  }
}

function resolveFeedback(sample:AkashaLearningSample,current:number,memberships:Map<string,Set<number>>):TurnFeedback{
  const remember=new Set<number>(),forget=new Set<number>();
  for(const receipt of sample.feedback??[])for(const target of receipt.targetSourceIds){
    if(receipt.action==="remember"&&sample.inputSourceIds.includes(target))remember.add(current);
    for(const node of memberships.get(target)??[])if(node<current)(receipt.action==="remember"?remember:forget).add(node);
  }
  // Source exclusion has priority over reinforcing an earlier receipt in this experience.
  for(const node of forget)remember.delete(node);
  return {remember_nodes:[...remember].sort((a,b)=>a-b),forget_nodes:[...forget].sort((a,b)=>a-b),remember_boost:remember.size?3:1};
}
