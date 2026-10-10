// Run this complete file through Codex functions.exec. Requires Chat On Steroids Desktop.
// It opens one owned browser tab, reads the session, saves authsession.json and closes that tab.
// Replace this with the absolute path of your checkout before running.
const root='C:/path/to/ThreadBridge';
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function unpack(reply) {
  if(reply.isError)throw new Error(reply.content?.find(x=>x.type==='text')?.text ?? 'Browser action failed');
  if(reply.structuredContent?.value)return reply.structuredContent.value;
  const block=reply.content?.find(x=>x.type==='text');return block?JSON.parse(block.text):reply;
}
const preparedReply=await tools.exec_command({cmd:'node scripts/encrypted-authsession.mjs prepare data',workdir:root,max_output_tokens:4000});
if(preparedReply.exit_code!==0)throw new Error('Could not prepare private session capture');
const prepared=JSON.parse(preparedReply.output);
let saved=false;
try {
  const expression='('+prepared.browserFunction+')('+JSON.stringify(prepared.publicKey)+')';
  const browserCode=`
    ${unpack.toString()}
    let opened=null,attached=null,packet=null,failure=null,closeError=null;
    try {
      const listing=unpack(await tools.browser_tabs({action:'list',filter:'chatgpt.com',limit:30}));
      if(!listing.browserId)throw new Error('No connected browser');
      opened=unpack(await tools.browser_tabs({action:'new',browserId:listing.browserId,url:'https://chatgpt.com/'}));
      if(!opened.created)throw new Error('Capture tab was not created');
      attached=opened.attached&&opened.pageId?opened:unpack(await tools.browser_tabs({action:'attach',tabId:opened.tabId}));
      if(!attached.pageId)throw new Error('Capture tab was not attached');
      const result=unpack(await tools.browser_evaluate({tabId:opened.tabId,pageId:attached.pageId,expression:${JSON.stringify(expression)}}));
      packet=result.value ?? result;
      if(packet.version!==1||!packet.cipher)throw new Error('Invalid encrypted browser response');
    }catch(e){failure=e.message;}
    finally {
      if(opened?.created){try{unpack(await tools.browser_tabs({action:'close',tabId:opened.tabId}));}catch(e){closeError=e.message;}}
    }
    text({ok:!failure&&!closeError,packet,error:failure,closeError,tabClosed:Boolean(opened?.created)&&!closeError});
  `;
  const captured=unpack(await tools.mcp__codex_apps__chat_on_steroids_desktop_exec({code:browserCode}));
  if(!captured.ok)throw new Error(captured.error ?? captured.closeError ?? 'Session capture failed');
  const packetPath=prepared.packetFile.replaceAll('\\','/');
  await tools.apply_patch('*** Begin Patch\n*** Add File: '+packetPath+'\n+'+JSON.stringify(captured.packet)+'\n*** End Patch');
  const result=await tools.exec_command({cmd:'node scripts/encrypted-authsession.mjs finish '+[prepared.keyFile,prepared.packetFile,prepared.destination].map(quote).join(' '),workdir:root,max_output_tokens:1200});
  if(result.exit_code!==0)throw new Error('Could not save session: '+result.output.trim());
  saved=true;text({...JSON.parse(result.output),tabClosed:captured.tabClosed});
}catch(e){text({ok:false,saved:false,error:e.message});}
finally {
  if(!saved){const cleanup=await tools.exec_command({cmd:'node scripts/encrypted-authsession.mjs cleanup '+[prepared.keyFile,prepared.packetFile].map(quote).join(' '),workdir:root,max_output_tokens:1200});
    if(cleanup.exit_code!==0)text({ok:false,error:'Capture temporary files could not be cleaned'});}
}
