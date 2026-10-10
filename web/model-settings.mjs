import {labels as l} from './labels.mjs';

export function setupModelSettings(){
  const get=id=>document.getElementById(id);let data,busy=false,loading=false,version=0,editing=null,client=null,listSignature='',choiceSignature='',mutationError=false;
  const message=code=>l.modelErrors[code]??l.modelSettingsError;
  const error=(id,text)=>{get(id).textContent=text;get(id).hidden=!text;};
  function fields(){
    const kind=get('model-kind').value,protocol=get('model-protocol').value,isClient=kind==='client',custom=kind==='local'||protocol==='compatible';
    get('model-protocol-field').hidden=kind!=='api';get('model-endpoint-field').hidden=isClient||!custom;get('model-endpoint').required=!isClient&&custom;
    get('model-key-field').hidden=isClient;get('model-key').required=kind==='api'&&!editing;
    get('model-endpoint').placeholder=kind==='local'?'http://127.0.0.1:11434/v1':'https://api.example.com/v1';
    get('model-add-note').textContent=isClient?l.modelClientNote:kind==='local'?l.modelLocalNote:l.modelApiNote;
  }
  function showForm(row){
    mutationError=false;error('model-error','');
    editing=row?.id??null;get('model-form').reset();get('model-name').value=row?.name??'';get('model-kind').value=row?.kind??'api';
    get('model-protocol').value=row?.protocol==='mcp'?'openai':row?.protocol??'openai';get('model-endpoint').value=row?.endpoint??'';
    get('model-form').hidden=false;fields();get('model-name').focus();
  }
  function showClient(id){
    client=id;const row=data?.items.find(r=>r.id===client);
    get('client-setup').hidden=!row;if(row){get('client-config').textContent=JSON.stringify(row.config,null,2);get('client-setup').open=true;get('client-config').focus();}
  }
  function row(item){
    const li=document.createElement('li'),info=document.createElement('div'),name=document.createElement('strong'),state=document.createElement('span'),actions=document.createElement('div');
    li.className='model-row';info.className='model-info';actions.className='sync-actions';name.textContent=item.name;
    state.textContent=(l.modelStates[item.status]??l.modelStates['connection-error'])+(item.error?' · '+message(item.error):'');state.className=item.error?'error':'muted';info.append(name,state);li.append(info,actions);
    const button=(label,action)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.disabled=busy;b.addEventListener('click',action);actions.append(b);};
    button(item.kind==='client'?l.modelConfig:l.modelReconnect,()=>item.kind==='client'?showClient(item.id):void mutate({action:'refresh',id:item.id}));
    button(l.modelEdit,()=>showForm(item));button(l.modelRemove,()=>void mutate({action:'remove',id:item.id}));return li;
  }
  function renderSummary(){
    if(!data)return;const settings=data.settings,target=data.items.find(r=>r.id===settings.connection);
    get('summary-quota').hidden=target?.kind==='client';
    const signature=JSON.stringify(data.items.map(r=>[r.id,r.name,r.models,r.status]));
    if(signature!==choiceSignature){choiceSignature=signature;const choices=[new Option(l.chooseSummaryModel,'')];
      for(const item of data.items)for(const model of item.models){const option=new Option(`${item.name} · ${item.kind==='client'?l.clientCurrentModel:model}`,JSON.stringify([item.id,model]));
        option.disabled=item.kind!=='client'&&item.status!=='connected';choices.push(option);}
      get('summary-model').replaceChildren(...choices);
    }
    get('summary-model').value=target?JSON.stringify([settings.connection,settings.model]):'';get('summary-model').disabled=busy||!data.items.length;
    get('summary-run').textContent=target?.kind==='client'?l.modelConfig:settings.running?l.pauseSummary:target?l.startSummary:l.connectModel;
    get('summary-run').disabled=busy||Boolean(target&&target.kind!=='client'&&(!data.indexEnabled||target.status!=='connected')&&!settings.running);
    get('summary-status').textContent=!target?l.summaryNoModel:!data.indexEnabled?l.summaryIndexPaused:target.kind==='client'?l.summaryClient:settings.running?(data.pendingSummaries===0?l.summaryCurrent:l.summaryRunning):settings.completed||settings.error?l.summaryPaused:l.summaryReady;
    get('index-summary-mode').textContent=target?.kind==='client'?l.modelClientNote:target?l.summaryBackground:l.summaryNoModel;
    get('summary-destination').textContent=target?(target.kind==='client'?l.summaryClientDestination:(target.kind==='local'?l.summaryLocalDestination:l.summaryApiDestination)+' '+target.endpoint):'';
    if(document.activeElement!==get('summary-limit'))get('summary-limit').value=String(settings.dailyLimit);
    get('summary-usage').textContent=`${l.usageRequests} ${data.usage.requests} / ${settings.dailyLimit} · ${l.usageInput} ${data.usage.input_tokens} · ${l.usageOutput} ${data.usage.output_tokens}`;
    error('summary-error',settings.error?message(settings.error):'');
  }
  function render(value){
    data=value;const signature=JSON.stringify(value.items.map(r=>[r.id,r.name,r.kind,r.status,r.error,r.models]));
    if(signature!==listSignature){listSignature=signature;get('model-connections').replaceChildren(...value.items.map(row));}
    get('model-empty').hidden=Boolean(value.items.length);get('show-model').disabled=busy;
    if(client){const item=value.items.find(r=>r.id===client);get('client-setup').hidden=!item;if(item)get('client-config').textContent=JSON.stringify(item.config,null,2);}
    renderSummary();
  }
  async function request(value){
    const response=await fetch('/api/models',{cache:'no-store',signal:AbortSignal.timeout(value?60000:10000),
      ...(value?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{})});
    const result=await response.json();if(!response.ok)throw new Error(message(result.code));return result;
  }
  async function refresh(){
    if(busy||loading)return;loading=true;const current=version;
    try{const result=await request();if(current===version&&!busy){render(result);if(!mutationError)error('model-error','');}}
    catch{if(current===version)error('model-error',l.modelSettingsError);}
    finally{loading=false;}
  }
  function controls(){
    for(const e of document.querySelectorAll('#model-form input,#model-form select,#model-form button,#model-connections button,#summary-limit-form button,#summary-limit'))e.disabled=busy;
    get('show-model').disabled=busy||!data;renderSummary();
  }
  async function mutate(value){
    if(busy)return false;busy=true;version++;mutationError=false;controls();error('model-error','');
    try{render(await request(value));return true;}
    catch(e){
      // A failed reconnect persists its failure state; reload it instead of restoring an old Connected label.
      try{render(await request());}catch{if(data)render(data);}
      mutationError=true;error('model-error',e.message);return false;
    }
    finally{busy=false;controls();}
  }
  get('show-model').addEventListener('click',()=>showForm());get('cancel-model').addEventListener('click',()=>{get('model-form').hidden=true;get('model-key').value='';editing=null;get('show-model').focus();});
  get('model-kind').addEventListener('change',fields);get('model-protocol').addEventListener('change',fields);
  get('model-form').addEventListener('submit',async event=>{
    event.preventDefault();const kind=get('model-kind').value,custom=kind==='local'||get('model-protocol').value==='compatible';
    const value={action:'save',name:get('model-name').value.trim(),kind,...(editing?{id:editing}:{}),
      ...(kind==='client'?{}:{protocol:kind==='local'?'compatible':get('model-protocol').value,...(custom?{endpoint:get('model-endpoint').value.trim()}:{}),apiKey:get('model-key').value.trim()})};
    // Clear the input immediately; no key is returned in refreshes or saved in browser storage.
    get('model-key').value='';if(await mutate(value)){get('model-form').hidden=true;editing=null;get('show-model').focus();}
  });
  get('summary-model').addEventListener('change',()=>{const value=get('summary-model').value;if(!value){renderSummary();return;}
    const [connection,model]=JSON.parse(value);void mutate({action:'select',connection,model});});
  get('summary-run').addEventListener('click',()=>{const target=data?.items.find(r=>r.id===data.settings.connection);
    if(!target)showForm();else if(target.kind==='client')showClient(target.id);else void mutate({action:'run',running:!data.settings.running});});
  get('summary-limit-form').addEventListener('submit',event=>{event.preventDefault();void mutate({action:'limit',dailyLimit:Number(get('summary-limit').value)});});
  document.addEventListener('index-settings-updated',event=>{if(data){data.indexEnabled=event.detail.enabled;data.pendingSummaries=event.detail.pendingSummaries;renderSummary();}});
  setInterval(()=>{if(!document.hidden)void refresh();},3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});void refresh();
}
