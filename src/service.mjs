import {HttpTransport,CdpTransport} from './transport.mjs';
import {snapshot} from './model.mjs';
import {sync} from './sync.mjs';
export function integer(value,fallback,min,max) {
  if(value===undefined)return fallback;
  const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`Expected an integer between ${min} and ${max}`);return n;
}
export function ids(value) {
  const list=Array.isArray(value)?value:String(value ?? '').split(',');
  if(!list.length || list.length>100000 || list.some(x=>typeof x!=='string'|| !/^[A-Za-z0-9_-]{1,160}$/.test(x)))throw new Error('Invalid chat or project IDs');
  return [...new Set(list)];
}
export async function apiFor(store,options={}) {
  const endpoint=options.cdp ?? process.env.CHATGPT_CDP_URL;
  const api=endpoint?await CdpTransport.connect(endpoint,process.env.CHATGPT_ACCOUNT_ID):new HttpTransport();
  try {
    const identity=api.user?`${api.user}:${api.workspace ?? 'personal'}`:null;
    const previous=store.meta('source_identity');
    if(identity && previous && identity!==previous)throw new Error('Browser account changed: use a separate --account namespace');
    if(identity)store.meta('source_identity',identity);
    return api;
  } catch(e){api.close();throw e;}
}
export async function runSync(store,options={}) {
  const api=await apiFor(store,options);
  try{return await sync(api,store,{full:options.full===true,refresh:options.refresh===true,batch:options.batch===true,
    concurrency:integer(options.concurrency,1,1,8),max:integer(options.max,100000,1,100000),
    projectIds:options.projects?ids(options.projects):[]});}finally{api.close();}
}
export function importTrees(store,raw) {
  const list=Array.isArray(raw)?raw:Array.isArray(raw?.conversations)?raw.conversations:[raw];
  let changedMessages=0;const errors=[];
  for(const tree of list){try{const id=tree?.conversation_id ?? tree?.id;const parsed=snapshot(tree,id);changedMessages+=store.save(parsed).changed;}
    catch(e){errors.push({id:tree?.conversation_id ?? tree?.id ?? null,error:e.message});}}
  return {ok:!errors.length,imported:list.length-errors.length,changedMessages,errors};
}
