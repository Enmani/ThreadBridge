export function placeBubble(bubble,anchor){
  const rect=anchor.getBoundingClientRect(),size=bubble.getBoundingClientRect(),gap=parseFloat(getComputedStyle(bubble).paddingTop);
  bubble.style.left=Math.max(gap,Math.min(rect.left,window.innerWidth-size.width-gap))+'px';
  bubble.style.top=(rect.bottom+gap+size.height<=window.innerHeight?rect.bottom+gap:Math.max(gap,rect.top-size.height-gap))+'px';
}
export function setupHelp(){
  for(const button of document.querySelectorAll('[data-help]')){
    const bubble=document.getElementById(button.dataset.help);let pinned=false;
    const show=()=>{bubble.showPopover();placeBubble(bubble,button);},hide=()=>{if(!pinned)bubble.hidePopover();};
    button.addEventListener('pointerenter',show);button.addEventListener('focus',show);
    button.addEventListener('pointerleave',e=>{if(!bubble.contains(e.relatedTarget))hide();});
    bubble.addEventListener('pointerleave',e=>{if(e.relatedTarget!==button)hide();});button.addEventListener('blur',hide);
    button.addEventListener('click',()=>{pinned=!pinned;if(pinned)show();else bubble.hidePopover();});
    bubble.addEventListener('toggle',e=>{if(e.newState==='closed')pinned=false;button.setAttribute('aria-expanded',String(e.newState==='open'));});
  }
}
