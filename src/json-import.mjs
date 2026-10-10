import {snapshot} from './model.mjs';
import {saveImportedText,normalizeImportedText} from './imported-archive.mjs';

export const importLimit=64*1024*1024;
export class ImportError extends Error {
  constructor(code){super(code);this.code=code;this.status=400;}
}
const idValid=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);

function sourceLink(value){
  if(typeof value!=='string'||value.length>4096)throw new ImportError('missing-thread-id');
  let url;try{url=new URL(value);}catch{throw new ImportError('missing-thread-id');}
  const match=/^\/(?:g\/g-p-[A-Za-z0-9_-]+\/)?c\/([A-Za-z0-9_-]{1,160})\/?$/.exec(url.pathname);
  if(url.protocol!=='https:'||!['chatgpt.com','chat.openai.com'].includes(url.hostname)||url.username||url.password||url.port||!match)
    throw new ImportError('missing-thread-id');
  return {id:match[1],url:'https://chatgpt.com'+url.pathname,project:/\/g\/(g-p-[A-Za-z0-9_-]+)/.exec(url.pathname)?.[1]??null};
}

function messageTime(value){
  if(value==null||value==='')return '';
  if(typeof value!=='string'||value.length>128)throw new ImportError('invalid-message');
  // Preserve the source wall-clock value: this exporter does not declare a time zone.
  const text=value.trim(),match=/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  return match?`${match[1]}-${match[2].padStart(2,'0')}-${match[3].padStart(2,'0')}T${match[4].padStart(2,'0')}:${match[5]}:${match[6]??'00'}`:text;
}

function parseRecord(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ImportError('unsupported-format');
  if(raw.mapping){
    const id=raw.conversation_id??raw.id;
    if(!idValid(id))throw new ImportError('missing-thread-id');
    if(raw.native||raw.coverage&&raw.coverage!=='full-tree')throw new ImportError('unsupported-format');
    if(raw.metadata?.link&&sourceLink(raw.metadata.link).id!==id)throw new ImportError('conflicting-thread-id');
    try{return {kind:'tree',id,title:String(raw.title??'').slice(0,1000),snapshot:snapshot(raw,id)};}
    catch{throw new ImportError('invalid-tree');}
  }
  if(!raw.metadata||!Array.isArray(raw.messages)||!raw.messages.length||raw.messages.length>100000)
    throw new ImportError('unsupported-format');
  const link=sourceLink(raw.metadata.link),explicit=raw.conversation_id??raw.id;
  if(explicit!==undefined&&explicit!==link.id)throw new ImportError('conflicting-thread-id');
  const title=raw.metadata.title;
  if(typeof title!=='string'||!title.trim()||title.length>1000)throw new ImportError('invalid-title');
  const roles={Response:'assistant',Question:'user',assistant:'assistant',user:'user',system:'system'};
  const messages=raw.messages.map(message=>{
    const role=Object.hasOwn(roles,message?.role)?roles[message.role]:undefined,text=message?.say??message?.text,model=message?.model??'';
    if(!role||typeof text!=='string'||!text.trim()||text.length>2*1024*1024||typeof model!=='string'||model.length>128)
      throw new ImportError('invalid-message');
    return {role,text:normalizeImportedText(text),time:messageTime(message.time),model};
  });
  return {kind:'text',...link,title:title.trim(),messages};
}

export function importJson(store,raw){
  const list=Array.isArray(raw)?raw:Array.isArray(raw?.conversations)?raw.conversations:[raw];
  if(!list.length||list.length>100000)throw new ImportError('unsupported-format');
  const records=list.map(parseRecord); // Validate the complete file before any write.
  return store.transaction(()=>{
    const ids=new Set(records.map(r=>r.id)),existing=new Set([...ids].filter(id=>store.thread(id)));
    const result={ok:true,threads:ids.size,matchedThreads:existing.size,newThreads:ids.size-existing.size,addedMessages:0,duplicateMessages:0,items:[]};
    for(const record of records){
      let saved;
      if(record.kind==='text')saved=saveImportedText(store,record);
      else{
        const old=store.read(record.id),older=old?.coverage==='full-tree'&&record.snapshot.updated&&old.raw.update_time&&
          Date.parse(record.snapshot.updated)<Number(old.raw.update_time)*1000;
        const before=new Map(store.db.prepare('SELECT node,json FROM messages WHERE account=? AND thread=?').all(store.account,record.id).map(m=>[m.node,m.json]));
        const changed=older?0:record.snapshot.messages.filter(m=>before.get(m.nodeId)!==m.json).length;
        if(!older)store.save(record.snapshot);
        saved={added:changed,duplicates:record.snapshot.messages.length-changed,coverage:'full-tree',older:Boolean(older)};
      }
      result.addedMessages+=saved.added;result.duplicateMessages+=saved.duplicates;
      result.items.push({id:record.id,title:store.thread(record.id)?.title??record.title,...saved});
    }
    store.meta('last_json_import',JSON.stringify({...result,at:new Date().toISOString()}));
    return result;
  });
}
