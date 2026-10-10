// ISOLATED world: the only bridge from the page into the extension's local outbox.
(() => {
  if(window.__threadbridgeRelay)return;window.__threadbridgeRelay=true;
  const channel='threadbridge-browser-archive-v1';
  let retries=0;
  const settings=()=>chrome.runtime.sendMessage({type:'archive-settings'}).then(value=>
    window.postMessage({channel,type:'settings',enabled:value?.enabled===true},location.origin)).catch(()=>{});
  window.addEventListener('message',event=>{
    if(event.source!==window||event.origin!==location.origin||event.data?.channel!==channel)return;
    if(event.data.type==='ready')void settings();
    if(event.data.type==='archive-state')void chrome.runtime.sendMessage({type:'archive-state',state:event.data.state}).catch(()=>{});
    if(event.data.type==='capture')void chrome.runtime.sendMessage({type:'archive-capture',payload:event.data.payload}).then(result=>{
      if(result?.queued)retries=0;
      else if(result?.state!=='disabled'&&retries++<3)setTimeout(()=>window.postMessage({channel,type:'retry'},location.origin),10000);
    }).catch(()=>{});
  });
  chrome.runtime.onMessage.addListener(message=>{if(message?.type==='archive-settings')void settings();});
  void settings();
})();
