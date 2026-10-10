export const claudeDirectory=(id='same-id',updated='2026-10-01T00:00:00Z')=>({uuid:id,name:'Claude example',updated_at:updated});
export function claudeDetail(id='same-id'){
  return {uuid:id,name:'Claude example',updated_at:'2026-10-01T00:00:00Z',chat_messages:[
    {uuid:'u',sender:'human',text:'question',content:[{type:'text',text:'question'}]},
    {uuid:'a',parent_message_uuid:'u',sender:'assistant',content:[{type:'text',text:'Claude searchable reply'},{type:'tool_use',name:'example',input:{x:1}}]},
    {uuid:'b',parent_message_uuid:'u',sender:'assistant',text:'Alternate Claude branch'}]};
}
export const geminiDirectory=(id='c_example',cursor=null)=>[null,cursor,[[id,'Gemini example',false,null,null,[1790812800,0]]]];
export function geminiDetail(id='c_example'){
  const candidate=(cid,text)=>{const row=[cid,[text]];row[8]=[2];return row;};
  return {conversation_id:id,body:[[
    [[id,'r_new'],null,[['latest question']],[[candidate('rc_new','Newest Gemini searchable reply')]], [1790812801,0]],
    [[id,'r_old'],null,[['first question']],[[candidate('rc_first','Earlier Gemini reply'),candidate('rc_alt','Alternate Gemini candidate')]], [1790812800,0]]
  ],null]};
}
