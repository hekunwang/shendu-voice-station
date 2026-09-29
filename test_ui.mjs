import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
class Element {
  constructor() { this.value = ''; this.textContent = ''; this.hidden = false; this.children = []; this.dataset = {}; this.events = {}; this.attributes = {}; this.paused = true; this.classList = {add(){},remove(){},toggle(){}}; }
  addEventListener(name, fn) { this.events[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key,value) { this.attributes[key]=value; }
  getAttribute(key) { return this.attributes[key]; }
  hasAttribute(key) { return key in this.attributes; }
  removeAttribute(key) { delete this.attributes[key]; }
  pause() {} load() {} close() {} remove() {} prepend() {} after() {}
}
function harness(file, exports) {
  const nodes = new Map(), timers = [];
  const $ = id => { if (!nodes.has(id)) nodes.set(id,new Element()); return nodes.get(id); };
  const context = {document: {getElementById:$,createElement:()=>new Element(),createElementNS:()=>new Element(),createDocumentFragment:()=>new Element(),querySelectorAll:()=>[],addEventListener(){},body:new Element()},
    location:{origin:'https://example.test'},URL,URLSearchParams,Option:class extends Element {constructor(text,value){super();this.textContent=text;this.value=value;}},
    crypto:{randomUUID:()=> 'request-uuid'},clearTimeout(){},setTimeout(fn,delay){timers.push({fn,delay});return timers.length;},
    fetch:()=>new Promise(()=>{}),console,confirm:()=>true};
  vm.createContext(context);
  const source = fs.readFileSync(new URL(`./ui/${file}`,import.meta.url),'utf8').replace(/\}\)\(\);\s*$/,`globalThis.test = {${exports}};})();`);
  vm.runInContext(source,context);
  return {context,nodes,$,timers,test:context.test};
}
const reply = data => ({ok:true,status:200,json:async()=>data});
const flush = () => new Promise(resolve=>setImmediate(resolve));
{
  const h = harness('app.js','state,refreshJobs,setFilter');
  h.test.state.authenticated=true; h.test.state.csrf='csrf'; h.test.state.voiceId='female'; h.test.state.voices=[{id:'female',available:true}];
  h.test.state.catalogAt=Date.now(); h.$('speech-text').value='原来的文本';
  let release;
  h.context.fetch = async (path, options) => options.method==='POST' ? new Promise(resolve=>{release=resolve;}) : reply({active_jobs:[],history_jobs:[],worker:{ready:true}});
  const submitted=h.$('generation-form').events.submit({preventDefault(){}});
  h.$('speech-text').value='等待提交时写的新文本';
  release(reply({ok:true})); await submitted;
  assert.equal(h.$('speech-text').value,'等待提交时写的新文本','in-flight submission must retain new draft');
}
{
  const h=harness('app.js','state,refreshJobs,setFilter'); h.test.state.authenticated=true; h.test.state.catalogAt=Date.now();
  let release; h.context.fetch=()=>new Promise(resolve=>{release=resolve;});
  const pending=h.test.refreshJobs(); h.test.setFilter('failed');
  release(reply({active_jobs:[],history_jobs:[],worker:{ready:true}})); await pending;
  assert(h.timers.some(timer=>timer.delay===0),'filter change during poll must refresh immediately');
}
{
  const h=harness('admin.js','state,mutate'); h.test.state.user={id:1,role:'admin'};
  const sent=[]; let release;
  h.context.fetch=async(path,options)=>{
    if(options.method==='PATCH'){sent.push(path);if(sent.length===1) await new Promise(resolve=>{release=resolve;});return reply({ok:true});}
    if(path==='/api/admin/overview')return reply({settings:{max_text_length:300,accepting_jobs:true},users:[],voices:[],audit:[]});
    return reply({jobs:[],next_before:null});
  };
  h.$('max-length').value='123';h.$('settings-form').events.input();
  const first=h.test.mutate('/voice/a','PATCH',{},'one'); const second=h.test.mutate('/voice/b','PATCH',{},'two');
  await flush(); assert.deepEqual(sent,['/voice/a']); release(); await Promise.all([first,second]);
  assert.deepEqual(sent,['/voice/a','/voice/b'],'parallel admin actions must both reach server');
  assert.equal(h.$('max-length').value,'123','unrelated mutations must retain dirty settings');
}
console.log('4 UI behavior checks passed');
{
  const h=harness('app.js','state,api'); h.test.state.authenticated=true;
  let release; h.context.fetch=()=>new Promise(resolve=>{release=resolve;});
  const oldRequest=h.test.api('/api/jobs');
  h.test.state.epoch++; // User logged into a new session while old request was pending.
  h.$('speech-text').value='新会话的草稿';
  release({ok:false,status:401,json:async()=>({error:{message:'请先登录'}})});
  await assert.rejects(oldRequest);
  assert.equal(h.test.state.authenticated,true,'old session 401 must not log out new session');
  assert.equal(h.$('speech-text').value,'新会话的草稿');
  const currentRequest=h.test.api('/api/jobs');
  release({ok:false,status:401,json:async()=>({error:{message:'请先登录'}})});
  await assert.rejects(currentRequest);
  assert.equal(h.test.state.authenticated,false,'current session 401 must still log out');
}
console.log('Stale/current 401 regression checks passed');
{
  const h=harness('app.js','state,jobQuery');
  h.$('history-voice').value='  西王  ';
  h.$('history-voice').events.input();
  assert(h.timers.some(timer=>timer.delay===300),'role search is debounced');
  const query=new URL(h.test.jobQuery(123),'https://example.test').searchParams;
  assert.equal(query.get('voice_query'),'西王');
  assert.equal(query.get('before'),'123','search persists on older pages');
  assert.equal(query.has('voice_id'),false);
}
console.log('History role search checks passed');
{
  const h=harness('app.js','state'); h.test.state.csrf='anonymous-csrf'; h.$('login-button').disabled=false;
  h.$('auth-toggle').events.click();
  assert.equal(h.$('password').autocomplete,'new-password');
  h.$('username').value='new-user';h.$('password').value='test-only-password';
  const calls=[];const me={authenticated:true,user:{id:'new',username:'new-user',role:'user'},csrf_token:'registered-csrf'};
  h.context.fetch=async(path,options)=>{calls.push([path,options.method]);
    if(path==='/api/register' || path==='/api/me')return reply(me);
    if(path==='/api/voices')return reply({voices:[],settings:{max_text_length:300,accepting_jobs:true}});
    if(path==='/portraits.json')return reply({portraits:{}});
    return reply({active_jobs:[],history_jobs:[],worker:{ready:true}});
  };
  await h.$('login-form').events.submit({preventDefault(){}});
  assert(calls.some(([path,method])=>path==='/api/register'&&method==='POST'));
  assert.equal(h.test.state.authenticated,true);assert.equal(h.test.state.user.role,'user');
  assert.equal(h.$('password').value,'');assert.equal(h.$('auth-toggle').disabled,false);
}
console.log('Registration UI flow check passed');
