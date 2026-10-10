import {placeBubble} from './floating-ui.mjs';
import {labels as l} from './labels.mjs';

export function setupSort(onChange,{sort='source_updated',order='desc'}={}){
  const menu=document.getElementById('sort-menu'),field=document.getElementById('sort-field'),direction=document.getElementById('sort-direction');let anchor=null;
  const buttons=[...document.querySelectorAll('[data-sort]')];
  const update=()=>{
    for(const button of buttons){const selected=button.dataset.sort===sort;button.closest('th').setAttribute('aria-sort',selected?order==='asc'?'ascending':'descending':'none');button.querySelector('.sort-arrow').textContent=selected?order==='asc'?' ↑':' ↓':' ↕';}
    field.value=sort;direction.value=order;
  };
  function choose(key,value){sort=key;order=value;update();onChange({sort,order});}
  for(const button of buttons){
    button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls','sort-menu');button.setAttribute('aria-expanded','false');
    button.addEventListener('click',()=>{
      if(menu.matches(':popover-open')&&anchor===button){menu.hidePopover();return;}
      for(const other of buttons)other.setAttribute('aria-expanded','false');
      anchor=button;button.setAttribute('aria-expanded','true');document.getElementById('sort-heading').textContent=l.sortColumns[button.dataset.sort];menu.showPopover();placeBubble(menu,button);menu.querySelector('[data-order]').focus();
    });
  }
  menu.setAttribute('role','dialog');menu.setAttribute('aria-labelledby','sort-heading');
  menu.addEventListener('toggle',()=>{if(!menu.matches(':popover-open'))for(const button of buttons)button.setAttribute('aria-expanded','false');});
  for(const button of menu.querySelectorAll('[data-order]'))button.addEventListener('click',()=>{choose(anchor.dataset.sort,button.dataset.order);menu.hidePopover();anchor.focus();});
  field.addEventListener('change',()=>choose(field.value,direction.value));direction.addEventListener('change',()=>choose(field.value,direction.value));
  update();
}
