import {readJsonRequest} from './http-json.mjs';
import {modelView,saveModelConnection,refreshModelConnection,removeModelConnection,configureSummary} from './model-connections.mjs';
import {modelError} from './model-transport.mjs';
import {indexEnabled} from './chat-index.mjs';

export async function modelRequest(request,root,providers,origin,worker){
  if(request.method==='POST'){
    if(request.headers.origin!==origin)throw modelError('foreign-origin',403);
    if(request.headers['content-type']?.split(';')[0].trim()!=='application/json')throw modelError('unsupported-format',415);
    const value=await readJsonRequest(request,{maxBytes:16384,timeoutMs:10000});
    if(!value||typeof value!=='object'||Array.isArray(value))throw modelError('invalid-model-settings');
    if(value.action==='save')await saveModelConnection(root,value);
    else if(['remove','refresh'].includes(value.action)&&Object.keys(value).length===2&&typeof value.id==='string'){
      if(value.action==='remove')removeModelConnection(root,value.id);else await refreshModelConnection(root,value.id);
    }else{
      if(value.action==='run'&&value.running&&!providers.every(p=>indexEnabled(root.scope(p))))throw modelError('model-index-paused',409);
      configureSummary(root,value);
    }
    worker.cancel();
  }else if(request.method!=='GET')throw modelError('unsupported-method',405);
  return modelView(root,providers);
}
