import { createServer, type ServerResponse } from "node:http";

export type EmbeddingWire = {model:string;input:string[]};
export async function embeddingFixture(vector:(text:string)=>number[], handle?:(wire:EmbeddingWire,response:ServerResponse)=>void|Promise<void>) {
  const requests:EmbeddingWire[]=[];
  const server=createServer(async(request,response)=>{
    let body="";for await(const chunk of request)body+=chunk;
    try {
      const wire=JSON.parse(body) as EmbeddingWire;requests.push(wire);
      if(handle)await handle(wire,response);
      else {response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({data:wire.input.map((text,index)=>({index,embedding:vector(text)}))}));}
    } catch {response.writeHead(500);response.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw new Error("Missing embedding fixture port");
  return {requests,baseUrl:`http://127.0.0.1:${address.port}/v1`,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
