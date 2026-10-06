import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("HTTP fixture surfaces callback errors and stalled responses without hanging the runner", async () => {
  for (const handler of ['throw new Error("intentional assertion failure")', 'await new Promise(() => {})']) {
    const script = `import test from 'node:test';
      import {createTestServer} from './test/fixtures/http-server.ts';
      test('fixture failure', async t=>{
        const server=createTestServer(t,async(req,res)=>{${handler}},100);
        await new Promise(r=>server.listen(0,'127.0.0.1',r));
        t.after(()=>{server.closeAllConnections();server.close();});
        const response=await fetch('http://127.0.0.1:'+server.address().port);
        if(response.status!==500)throw Error('request did not terminate');
        await response.text();
      });`;
    await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 10000 }),
      (error: unknown) => {
        const failure = error as { code?: number; killed?: boolean; stdout?: string };
        assert.equal(failure.killed, false);
        assert.equal(failure.code, 1);
        assert.match(failure.stdout ?? "", /HTTP fixture failed/);
        return true;
      });
  }
});
