export function readJsonRequest(request,{maxBytes=1024,timeoutMs=5000}={}){
  return new Promise((resolve,reject)=>{
    let chunks=[],size=0,finished=false;
    const finish=(error,value)=>{
      if(finished)return;finished=true;clearTimeout(timer);
      request.removeListener('data',data);request.removeListener('end',end);request.removeListener('error',failed);request.removeListener('aborted',failed);
      if(error){request.resume();reject(error);}else resolve(value);
    };
    const error=(code,status=400)=>Object.assign(new Error(code),{status,code});
    const failed=()=>finish(error('invalid-json'));
    const data=chunk=>{size+=chunk.length;if(size>maxBytes)finish(error('file-too-large',413));else chunks.push(chunk);};
    const end=()=>{try{
      const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)).replace(/^\uFEFF/,'');
      finish(null,JSON.parse(text));
    }catch{failed();}};
    const timer=setTimeout(()=>finish(error('import-timeout',408)),timeoutMs);
    request.on('data',data);request.once('end',end);request.once('error',failed);request.once('aborted',failed);
  });
}
