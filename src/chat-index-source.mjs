import {snapshot,canonical} from './model.mjs';
import {providerSnapshot} from './providers.mjs';

// Index every locally retained version. Original snapshots remain the source of truth.
export function archiveChunks(store,thread){
  const chunks=[],variants=new Map();
  for(const [source,table] of [['native','snapshots'],['browser','browser_snapshots'],['import','imported_snapshots']]){
    const rows=store.db.prepare(`SELECT * FROM ${table} WHERE account=? AND thread=? ORDER BY revision`).iterate(store.account,thread);
    for(const row of rows){
      const raw=JSON.parse(row.raw);
      let messages;
      if(source==='native'){
        const snap=store.provider==='chatgpt'?snapshot(raw,thread,row.coverage):providerSnapshot(store.provider,raw,thread);
        messages=snap.messages;
        if(raw.mapping){
          // Preserve branch adjacency instead of the canonical JSON object's key order.
          const ordered=[],seen=new Set(),stack=Object.keys(raw.mapping).filter(id=>!raw.mapping[id].parent).reverse(),byId=new Map(messages.map(m=>[m.nodeId,m]));
          while(stack.length){const id=stack.pop();if(seen.has(id))continue;seen.add(id);if(byId.has(id))ordered.push(byId.get(id));stack.push(...(raw.mapping[id].children??[]).toReversed());}
          messages=[...ordered,...messages.filter(m=>!seen.has(m.nodeId))];
        }
      }else{
        messages=raw.messages.map(m=>({nodeId:m.id,messageId:m.id,role:m.role,text:m.text,json:canonical(m)}));
      }
      for(const message of messages){
        const key=canonical([source,message.nodeId,message.json]);
        if(variants.has(key)){for(const c of variants.get(key))c.reference.lastRevision=row.revision;continue;}
        const parts=[],points=[...message.text];
        for(let offset=0;offset<Math.max(1,points.length);offset+=2048){
          const part={text:points.slice(offset,offset+2048).join(''),reference:{provider:store.provider,thread,source,
            revision:row.revision,lastRevision:row.revision,node:message.nodeId,message:message.messageId,role:message.role,
            coverage:source==='native'?row.coverage:source==='browser'?'page-text':'export-text',
            start:offset,end:Math.min(offset+2048,points.length),offsetUnit:'unicode-code-point'}};
          parts.push(part);chunks.push(part);
        }
        variants.set(key,parts);
      }
    }
  }
  return chunks;
}
