import {canonical,timestamp,snapshot} from './model.mjs';

export const providerNames=Object.freeze({chatgpt:'ChatGPT',claude:'Claude',gemini:'Gemini'});
export function providerId(value='chatgpt'){
  if(!Object.hasOwn(providerNames,value))throw new Error('Unsupported history provider');return value;
}
export function accountKey(provider,account){
  providerId(provider);
  if(typeof account!=='string'||!account||account.startsWith('@threadbridge/'))throw new Error('Invalid account namespace');
  // Preserve the public ChatGPT database contract; reserved keys isolate every other provider.
  return provider==='chatgpt'?account:`@threadbridge/${provider}/${JSON.stringify(account)}`;
}
export function detailPath(provider,id){
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id))throw new Error('Invalid conversation ID');
  return provider==='chatgpt'?`/backend-api/conversation/${id}`:`/history/conversation/${id}`;
}
function validObject(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function textBlocks(value){
  if(value===undefined)return null;
  if(!Array.isArray(value)||value.some(b=>!validObject(b)))throw new Error('Invalid Claude content blocks');
  return value.filter(b=>b.type==='text').map(b=>{if(typeof b.text!=='string')throw new Error('Invalid Claude text');return b.text;}).join('\n');
}
export function providerSnapshot(provider,raw,id,title=''){
  if(provider==='chatgpt')return snapshot(raw,id);
  providerId(provider);
  if(!validObject(raw))throw new Error('Invalid provider conversation');
  const messages=[],seen=new Set();
  const add=(nodeId,role,text,data)=>{
    if(typeof nodeId!=='string'||!nodeId||seen.has(nodeId)||typeof text!=='string')throw new Error('Invalid or duplicate provider message');
    seen.add(nodeId);messages.push({nodeId,messageId:nodeId,role,text,json:canonical(data)});
  };
  let updated=null,lastMessageId=null,lastAssistantId=null;
  if(provider==='claude'){
    if(raw.uuid!==id||!Array.isArray(raw.chat_messages)||raw.truncated||raw.is_truncated||raw.has_more)throw new Error('Invalid or truncated Claude conversation');
    for(const m of raw.chat_messages){
      if(!validObject(m)||!['human','assistant'].includes(m.sender))throw new Error('Invalid Claude message');
      const text=textBlocks(m.content)??m.text;
      add(m.uuid,m.sender==='human'?'user':'assistant',text??'',m);
      lastMessageId=m.uuid;if(m.sender==='assistant')lastAssistantId=m.uuid;
    }
    title=typeof raw.name==='string'?raw.name:title;updated=timestamp(raw.updated_at);
  }else{
    if(raw.conversation_id!==id||!Array.isArray(raw.body)||!Array.isArray(raw.body[0]))throw new Error('Invalid Gemini conversation');
    const turns=raw.body[0];
    // The web RPC exposes a turn limit, not a documented complete-tree contract.
    if(turns.length>=10000||raw.body[1]!=null)throw new Error('Gemini history exceeded the supported turn window');
    for(const turn of [...turns].reverse()){
      if(!Array.isArray(turn)||turn[0]?.[0]!==id||typeof turn[0]?.[1]!=='string'||!turn[0][1])throw new Error('Invalid Gemini turn identity');
      const rid=turn[0][1],user=turn[2]?.[0]?.[0],candidates=turn[3]?.[0];
      if(typeof user!=='string'||!Array.isArray(candidates))throw new Error('Invalid Gemini turn content');
      add(rid+':user','user',user,{turn:rid,prompt:turn[2]});lastMessageId=rid+':user';
      for(const candidate of candidates){
        if(!Array.isArray(candidate)||typeof candidate[0]!=='string'||!candidate[0]||typeof candidate[1]?.[0]!=='string')throw new Error('Invalid Gemini candidate');
        const node=rid+':'+candidate[0];add(node,'assistant',candidate[1][0],{turn:rid,candidate});lastMessageId=lastAssistantId=node;
      }
    }
  }
  // Preserve native response fields (branches, attachments, tool blocks and candidates).
  // Text indexing does not assert that the remote service supplied a complete tree.
  return {id,title,updated,assistantUpdated:null,lastMessageId,lastAssistantId,coverage:'bounded-text',raw:canonical(raw),messages};
}

export function providerDirectory(provider,raw,scope){
  providerId(provider);let items,next=null,total=null;
  if(provider==='claude'){
    if(Array.isArray(raw))items=raw;
    else if(validObject(raw)){
      items=raw.conversations??raw.items;next=raw.next_cursor??raw.nextCursor??raw.cursor??null;total=raw.total??null;
      if(raw.has_more===true&&next==null&&total==null)throw new Error('Claude directory is missing pagination');
    }
    if(!Array.isArray(items))throw new Error('Invalid Claude directory');
    items=items.map(item=>{
      if(!validObject(item)||typeof item.uuid!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(item.uuid))throw new Error('Invalid Claude directory item');
      return {id:item.uuid,title:String(item.name??''),updated:timestamp(item.updated_at),assistantUpdated:null,
        project:item.project_uuid??item.project?.uuid??null,projectName:item.project?.name??null,scope};
    });
  }else{
    if(!Array.isArray(raw)||!Array.isArray(raw[2]))throw new Error('Invalid Gemini directory');
    next=raw[1]??null;
    items=raw[2].map(item=>{
      if(!Array.isArray(item)||typeof item[0]!=='string'||!/^c_[A-Za-z0-9_-]+$/.test(item[0])||typeof item[1]!=='string')throw new Error('Invalid Gemini directory item');
      const time=item[5];
      return {id:item[0],title:item[1],updated:Array.isArray(time)&&typeof time[0]==='number'?timestamp(time[0]+(time[1]??0)/1e9):null,assistantUpdated:null,project:null,scope};
    });
  }
  if(next!=null&&(typeof next!=='string'||!next||next.length>2048))throw new Error('Invalid provider directory cursor');
  if(total!=null&&(!Number.isSafeInteger(total)||total<0))throw new Error('Invalid provider directory total');
  if(new Set(items.map(i=>i.id)).size!==items.length)throw new Error('Duplicate provider directory items');
  return {items,next,total};
}
