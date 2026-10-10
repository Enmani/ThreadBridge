import {labels as l} from './labels.mjs';

export function setupIndexSettings(){
  const get=id=>document.getElementById(id);let busy=false,loading=false,version=0;
  function render(data){
    get('index-enabled').checked=data.enabled;
    get('index-state').textContent=data.errors?l.indexFailed:data.enabled?(data.pending?l.indexBuilding:data.eligible?l.indexCurrent:l.indexEmpty):l.indexPaused;
    get('index-count').textContent=`${data.indexed} / ${data.eligible}`;get('index-summaries').textContent=String(data.pendingSummaries);
    get('index-updated').textContent=data.updated?new Date(data.updated).toLocaleString():l.none;
    get('index-rebuild').disabled=!data.enabled||busy;
    get('index-error').textContent=data.errors?l.indexRetry:'';get('index-error').hidden=!data.errors;
  }
  async function request(options){
    const response=await fetch('/api/index',{cache:'no-store',signal:AbortSignal.timeout(10000),...options});
    if(!response.ok)throw new Error('Index settings unavailable');return response.json();
  }
  async function refresh(){
    if(busy||loading)return;loading=true;const current=version;
    try{const data=await request();if(current===version&&!busy){render(data);get('index-enabled').disabled=false;}}
    catch{if(current===version){get('index-error').textContent=l.indexSettingsError;get('index-error').hidden=false;}}
    finally{loading=false;}
  }
  async function change(value){
    if(busy)return;busy=true;version++;get('index-enabled').disabled=true;get('index-rebuild').disabled=true;
    get('index-error').hidden=true;
    try{render(await request({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}));}
    catch{get('index-error').textContent=l.indexSettingsError;get('index-error').hidden=false;
      if(value.enabled!==undefined)get('index-enabled').checked=!value.enabled;}
    finally{busy=false;get('index-enabled').disabled=false;get('index-rebuild').disabled=!get('index-enabled').checked;}
  }
  get('index-enabled').addEventListener('change',()=>void change({enabled:get('index-enabled').checked}));
  get('index-rebuild').addEventListener('click',()=>void change({rebuild:true}));
  setInterval(()=>{if(!document.hidden)void refresh();},3000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});void refresh();
}
