import {labels as l} from './labels.mjs';
import {setupTheme} from './theme.mjs';
const $=id=>document.getElementById(id);let busy=false,loading=false,choices='';
document.querySelectorAll('[data-label]').forEach(e=>e.textContent=l[e.dataset.label]);setupTheme($('theme'));
function fields(){for(const [id,provider] of [['claude-field','claude'],['gemini-field','gemini'],['chatgpt-field','chatgpt']])$(id).hidden=$('add-provider').value!==provider;}
async function refresh(){
  if(loading||busy)return;loading=true;
  try{
    const response=await fetch('/api/connections',{cache:'no-store'});if(!response.ok)throw new Error('Settings unavailable');const data=await response.json();
    if(busy)return;$('connections').replaceChildren(...data.items.map(item=>{const row=document.createElement('li'),name=document.createElement('strong'),state=document.createElement('span');name.textContent=item.name;state.textContent=l.connectionStates[item.status]??l.connectionStates['connection-error'];if(['login-required','account-changed','connection-error'].includes(item.status))state.className='error';row.append(name,state);return row;}));
    const signature=JSON.stringify(data.available);if(signature!==choices){choices=signature;$('add-provider').replaceChildren(...data.available.map(p=>{const option=document.createElement('option');option.value=p.id;option.textContent=p.name;return option;}));fields();}
    $('show-add').disabled=!data.available.length;$('settings-status').textContent=data.available.length?'':l.allPlatformsAdded;
    if($('settings-error').textContent===l.settingsError)$('settings-error').hidden=true;
  }catch{$('settings-error').textContent=l.settingsError;$('settings-error').hidden=false;}
  finally{loading=false;}
}
$('show-add').addEventListener('click',()=>{$('add-form').hidden=false;fields();$('add-provider').focus();});
$('cancel-add').addEventListener('click',()=>{$('add-form').hidden=true;$('show-add').focus();});$('add-provider').addEventListener('change',fields);
$('add-form').addEventListener('submit',async event=>{
  event.preventDefault();if(busy)return;busy=true;for(const id of ['add-submit','cancel-add','add-provider','show-add'])$(id).disabled=true;$('settings-error').hidden=true;
  const provider=$('add-provider').value,value={provider};
  if(provider==='gemini')value.authuser=Number($('gemini-account').value);
  else{const workspace=$(provider==='claude'?'claude-workspace':'chatgpt-workspace').value.trim();if(workspace)value.workspace=workspace;}
  try{
    const response=await fetch('/api/connections',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(10000)});
    if(!response.ok)throw new Error(response.status===409?'duplicate':'failed');$('add-form').hidden=true;
  }catch(e){$('settings-error').textContent=e.message==='duplicate'?l.platformDuplicate:l.addError;$('settings-error').hidden=false;}
  finally{busy=false;for(const id of ['add-submit','cancel-add','add-provider'])$(id).disabled=false;await refresh();}
});
setInterval(()=>{if(!document.hidden)void refresh();},3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});void refresh();
