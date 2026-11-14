import http from 'node:http';
import app from './worker/index.js';
const port=Number(process.env.PORT||10000);
const server=http.createServer(async(req,res)=>{
 try{
  const response=await app.fetch(new Request(new URL(req.url,'http://localhost'),{method:req.method}));
  res.writeHead(response.status,Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){console.error('Request failed:',error.name);res.writeHead(500,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:'服务暂不可用，请稍后重试'}));}
});
server.requestTimeout=35000;server.headersTimeout=15000;
server.listen(port,'0.0.0.0',()=>console.log('Paper trading server listening on '+port));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),25000).unref();});
