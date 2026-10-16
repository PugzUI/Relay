import http from 'node:http';
import { fork } from 'node:child_process';
import { mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes,createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { open } from '../../src/index.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PROTOTYPE_PORT??18848);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid PROTOTYPE_PORT');
const origin=`http://127.0.0.1:${port}`,token=randomBytes(32).toString('hex');
const directory=mkdtempSync(join(tmpdir(),'relay-workspace-'));mkdirSync(join(directory,'state'));
const root=join(directory,'state');const relay=open({root,device:'workspace-fixture',role:'hub'});
const operator=relay.register('worker',{slot:'900'}),operatorSession=relay.join(operator.id);
const workers=new Map(),clients=new Set();let logSeq=0,revision=0,lastHash='',closing=false;
const allowed=new Set(['help','status','claim','complete','run','auto on','auto off','message']);
function addLog(w,text){w.logs.push({seq:++logSeq,text:String(text).slice(0,4000)});if(w.logs.length>120)w.logs.splice(0,w.logs.length-120);}
for(const [slot,number] of [['alpha','001'],['beta','002']]){const agent=relay.register('worker',{slot:number});const w={id:agent.id,slot,pid:null,session:null,epoch:null,mid:null,automatic:false,online:false,logs:[]};const child=fork(join(here,'worker.mjs'),[],{stdio:['ignore','pipe','pipe','ipc'],cwd:directory,env:{...process.env}});w.child=child;workers.set(agent.id,w);child.stdout.on('data',b=>addLog(w,b.toString()));child.stderr.on('data',b=>addLog(w,b.toString()));child.on('message',m=>{if(m.type==='log')addLog(w,m.text);if(m.type==='state'){for(const key of ['session','epoch','mid','automatic','pid'])w[key]=m[key];w.online=true;}});child.on('exit',(code,signal)=>{w.online=false;w.mid=null;addLog(w,`PROCESS EXIT code=${code} signal=${signal??'none'}`);});child.on('error',e=>{w.online=false;addLog(w,`PROCESS ERROR ${e.message}`);});child.send({type:'init',root,worker:agent.id});}
function seed(count=3){const existing=relay.list({board:'bounty',kind:'work',limit:100}).total;if(existing+count>30)throw Error('Fixture work limit is 30');for(let i=0;i<count;i++)relay.post(operatorSession.id,'bounty',{work:{task:`Package ${existing+i+1}`,input:`fixture-payload-${existing+i+1}`,operation:'sha256'}});}
seed();
function auditEvents(){let page=relay.audit({limit:100}),events=[...page.items],pages=1;while(page.next){if(pages++>=32)throw Error('Fixture journal capacity reached');page=relay.audit({limit:100,after:page.next});events.push(...page.items);}return events.slice(-120).map(({sid,...event})=>event);}
function snapshot(){return {instance:directory.split('/').at(-1),revision,workers:[...workers.values()].map(({child,...w})=>({...w,session:w.session?{epoch:w.epoch}:null})),work:relay.list({board:'bounty',kind:'work',data:true,limit:100}).items,audit:auditEvents()};}
function json(res,code,data){res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>4096)throw Error('Request too large');chunks.push(chunk);}const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Expected object');return value;}
const types={'/':['index.html','text/html'],'/app.mjs':['app.mjs','text/javascript'],'/style.css':['workspace.css','text/css'],'/relay-style.css':['../../ui/style.css','text/css'],'/assets/app.js':['assets/app.js','text/javascript'],'/assets/app.css':['assets/app.css','text/css']};
const server=http.createServer(async(req,res)=>{try{if(req.headers.host!==`127.0.0.1:${port}`||req.headers['sec-fetch-site']==='cross-site')return json(res,403,{error:'Origin denied'});const url=new URL(req.url,origin);if(url.pathname==='/api/bootstrap'&&req.method==='GET')return json(res,200,{token,state:snapshot()});if(url.pathname==='/api/events'&&req.method==='GET'){if(clients.size>=12)return json(res,429,{error:'Too many streams'});res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});clients.add(res);res.write(`data: ${JSON.stringify(snapshot())}\n\n`);req.on('close',()=>clients.delete(res));return;}
if(url.pathname==='/api/action'&&req.method==='POST'){if(req.headers.origin!==origin||req.headers['x-prototype-token']!==token)return json(res,403,{error:'Action denied'});if(!String(req.headers['content-type']).startsWith('application/json'))return json(res,415,{error:'Expected JSON'});const input=await body(req);if(input.action==='seed'){if(Object.keys(input).some(k=>k!=='action'))return json(res,400,{error:'Unexpected fields'});seed(3);return json(res,200,{ok:true});}const w=workers.get(input.worker);if(!w||!w.online||!w.child.connected)return json(res,409,{error:'No live fixture session for this node'});if(input.action!=='command'||Object.keys(input).some(k=>!['action','worker','command'].includes(k))||!allowed.has(input.command))return json(res,403,{error:'Only scoped fixture worker commands are allowed; shell execution is unavailable'});addLog(w,`> ${input.command}`);w.child.send({type:'command',command:input.command});return json(res,202,{accepted:true});}
if(req.method==='GET'&&types[url.pathname]){const [file,type]=types[url.pathname];const content=readFileSync(join(here,file));res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",'X-Content-Type-Options':'nosniff'});res.end(content);return;}json(res,404,{error:'Not found'});}catch(e){json(res,400,{error:e.message});}});
server.headersTimeout=10000;server.requestTimeout=15000;
const refresh=setInterval(()=>{try{const state=snapshot(),hash=createHash('sha256').update(JSON.stringify({...state,revision:0})).digest('hex');if(hash!==lastHash){lastHash=hash;state.revision=++revision;const payload=`id: ${revision}\ndata: ${JSON.stringify(state)}\n\n`;for(const res of clients)if(!res.write(payload)){clients.delete(res);res.destroy();}}}catch(e){console.error('Snapshot failure',e.message);}},200);
const heartbeat=setInterval(()=>{try{relay.renew(operatorSession.id);}catch(e){console.error('Operator heartbeat failure',e.message);}for(const res of clients)res.write(': keepalive\n\n');},10000);
async function shutdown(){
  if(closing)return;closing=true;
  clearInterval(refresh);clearInterval(heartbeat);
  for(const res of clients)res.end();
  server.close();
  await Promise.all([...workers.values()].map(w=>new Promise(resolve=>{
    if(w.child.exitCode!==null||w.child.signalCode!==null)return resolve();
    const timer=setTimeout(()=>w.child.kill('SIGKILL'),1500);
    w.child.once('exit',()=>{clearTimeout(timer);resolve();});
    if(w.child.connected)w.child.send({type:'shutdown'},error=>{if(error)w.child.kill('SIGTERM');});
    else w.child.kill('SIGTERM');
  })));
  try{relay.leave(operatorSession.id);}catch(e){console.error(e.message);}
  try{relay.close();rmSync(directory,{recursive:true,force:true});}
  catch(e){console.error(`Fixture cleanup failed: ${e.message}`);process.exitCode=1;}
}
server.on('error',e=>{console.error(e.message);shutdown();});server.listen(port,'127.0.0.1',()=>{writeFileSync(join(directory,'run.json'),JSON.stringify({origin,root,pid:process.pid}),{mode:0o600});console.log(JSON.stringify({origin,root,pid:process.pid,fixture:true}));});process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);setTimeout(shutdown,2*60*60*1000).unref();
