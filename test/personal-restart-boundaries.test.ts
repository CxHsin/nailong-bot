import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';

async function killAtBoundary(directory: string, mode: 'result' | 'effect' | 'context') {
  const base = fileURLToPath(new URL('../src/personal/', import.meta.url));
  const script = `import {PersonalStore} from ${JSON.stringify(pathToFileURL(join(base, 'store.ts')).href)};
    import {PersonalHost} from ${JSON.stringify(pathToFileURL(join(base, 'host.ts')).href)};
    import {openSync,writeFileSync,fsyncSync,closeSync,readFileSync} from 'node:fs';
    const directory=${JSON.stringify(directory)}, mode=${JSON.stringify(mode)};
    const save=(name,text)=>{const f=openSync(directory+'/'+name,'w');writeFileSync(f,text);fsyncSync(f);closeSync(f);};
    const boundary=async()=>{console.log('READY');await new Promise(()=>{});};
    let starts=0; const store=new PersonalStore(directory); let host;
    const input={conversationId:'c',actorId:'a',inputId:'user',text:'goal'};
    host=new PersonalHost({store,dialogue:{async decide(_input,context){const work=context.work();work.delegate('child',{goal:'material',purpose:'research'});return {kind:'reply',text:'entrusted'};},
      async resume(event,context){
        if(mode==='result') return boundary();
        context.onInjection({sessionId:context.sessionId,entryId:'injected:'+event.id,at:1});save('injected',event.id);
        if(mode==='effect') return context.work().dispatch('external-effect',{kind:'external-send',target:'fixture',parameters:{},content:'effect'},async()=>{save('effect','1');await boundary();});
        return {outcome:'waiting',reviewedRevision:0,contextResponse:{version:1,content:'Selected original background',spans:[],agreementIds:[],source:'parent_selected',at:1},completion:{sessionId:context.sessionId,entryId:'done:'+event.id,at:2}};
      }},executor:{async execute(request){starts++;save('starts',String(starts));request.onIdentity({kind:'fixture',taskId:request.task.id});
        if(mode==='context' && !request.task.contextPacket){host.workContext({...input,inputId:request.attempt.id},request.task.id).requestContext('need','addressed background');const error=new Error('wait context');error.name='ExecutorContextError';throw error;}
        if(mode==='context' && request.task.contextPacket){save('presented',request.task.contextPacket.content);await boundary();}
        return {text:'material',verified:false,partial:true};}}});
    setInterval(()=>{},1000);await host.submit(input);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stderr.on('data', chunk => { errors += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error('boundary timeout: ' + errors)), 10000); child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('READY')) { clearTimeout(timer); resolve(); } }); child.once('exit', code => { clearTimeout(timer); reject(new Error('early exit ' + code + ': ' + errors)); }); });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve())); assert.equal(child.kill('SIGKILL'), true); await closed;
    assert.equal(child.exitCode === null || child.exitCode !== 0, true);
  } finally { if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await closed; } }
}

test('real process death after material settlement resumes the unique WorkEvent without rerunning helper', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'restart-material-')); t.after(() => rm(directory, { recursive: true, force: true })); await killAtBoundary(directory, 'result');
  let executions = 0; let resumes = 0; const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: '' }; }, async inspectContinuation() { return { state: 'absent' }; }, async resume(event, context) { resumes++; context.onInjection({ sessionId: context.sessionId, entryId: 'new-injection', at: 1 }); return { outcome: 'completed', reviewedRevision: 0, result: { text: 'final reviewed', verified: true }, completion: { sessionId: context.sessionId, entryId: 'new-completion', at: 2 } }; } }, executor: { async execute() { executions++; return { text: '', verified: false }; } } });
  try { await host.recover(); await host.waitForIdle(); await host.recover(); await host.waitForIdle(); assert.equal(executions, 0); assert.equal(resumes, 1); assert.equal(await readFile(join(directory, 'starts'), 'utf8'), '1'); assert.equal(store.listWorkEvents().length, 1); assert.equal(store.listWorkEvents()[0]?.state, 'consumed'); assert.equal(store.listDeliveries().filter(item => item.text === 'final reviewed').length, 1); }
  finally { await host.close(); }
});

test('real process death after an external effect leaves unknown work occupied and never repeats it', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'restart-effect-')); t.after(() => rm(directory, { recursive: true, force: true })); await killAtBoundary(directory, 'effect');
  let resumes = 0; let executions = 0; const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: '' }; }, async inspectContinuation(event, sessionId) { return { state: 'injected', injection: { sessionId, entryId: 'injected:' + event.id, at: 1 } }; }, async resume() { resumes++; throw new Error('must not repeat'); } }, executor: { async execute() { executions++; return { text: '', verified: false }; } } });
  try { await host.recover(); await host.waitForIdle(); await host.recover(); assert.equal(resumes, 0); assert.equal(executions, 0); assert.equal(await readFile(join(directory, 'effect'), 'utf8'), '1'); assert.equal(store.listWorkEvents()[0]?.state, 'unknown'); const root = host.listTasks().find(task => task.direct)!; assert.equal(root.resourceHeld, true); assert.equal(store.listDeliveries().some(item => item.text === 'final reviewed'), false); }
  finally { await host.close(); }
});

test('real process death after selected context response before helper acknowledgement preserves addressed material', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'restart-context-')); t.after(() => rm(directory, { recursive: true, force: true })); await killAtBoundary(directory, 'context');
  let presentations = 0; let contextResponses = 0; const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: '' }; }, async resume(event, context) { if (event.kind === 'context_request') contextResponses++; context.onInjection({ sessionId: context.sessionId, entryId: 'settle:' + event.id, at: 1 }); return { outcome: 'waiting', reviewedRevision: 0, completion: { sessionId: context.sessionId, entryId: 'done:' + event.id, at: 2 } }; } }, executor: { async inspect() { return { state: 'resumable' }; }, async execute(request) { presentations++; assert.equal(request.task.contextPacket?.content, 'Selected original background'); return { text: 'background consumed', verified: false, partial: true }; } } });
  try { await host.recover(); await host.waitForIdle(); assert.equal(presentations, 1); assert.equal(contextResponses, 0); const request = store.listWorkEvents().filter(event => event.kind === 'context_request'); assert.equal(request.length, 1); assert.equal(request[0]?.state, 'consumed'); assert.ok(request[0]?.completion); }
  finally { await host.close(); }
});
