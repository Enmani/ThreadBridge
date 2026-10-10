import {labels as l} from './labels.mjs';

export function setupImport(refresh){
  const button=document.getElementById('import-json'),input=document.getElementById('import-files');
  const status=document.getElementById('import-status'),errors=document.getElementById('import-errors');
  const limit=64*1024*1024;
  button.addEventListener('click',()=>input.click());
  input.addEventListener('change',async()=>{
    const files=Array.from(input.files??[]);if(!files.length)return;
    button.disabled=true;button.textContent=l.importing;errors.replaceChildren();errors.hidden=true;
    let imported=0,added=0,duplicates=0,matched=0,created=0;
    for(let i=0;i<files.length;i++){
      const file=files[i];status.textContent=l.importProgress(file.name,i+1,files.length);
      try{
        if(file.size>limit)throw {code:'file-too-large'};
        let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw {code:'invalid-json'};}
        const response=await fetch('/api/import',{method:'POST',headers:{'Content-Type':'application/json'},body:text,signal:AbortSignal.timeout(60000)});
        let result;try{result=await response.json();}catch{throw {code:'import-failed'};}
        if(!response.ok||!result.ok)throw {code:result.code??'import-failed'};
        imported++;added+=result.addedMessages;duplicates+=result.duplicateMessages;matched+=result.matchedThreads;created+=result.newThreads;
      }catch(error){
        const line=document.createElement('li');line.textContent=file.name+'：'+(l.importErrors[error.code]??l.importErrors['import-failed']);
        errors.append(line);errors.hidden=false;
      }
    }
    status.textContent=l.importResult(imported,matched,created,added,duplicates);
    input.value='';button.disabled=false;button.textContent=l.importJson;await refresh();
  });
}
