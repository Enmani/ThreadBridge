// Chrome Native Messaging: 4-byte little-endian UTF-8 JSON frames on Windows.
export function frame(value,max=1024*1024) {
  const body=Buffer.from(JSON.stringify(value));if(!body.length||body.length>max)throw new Error('Native message exceeds limit');
  const header=Buffer.alloc(4);header.writeUInt32LE(body.length);return Buffer.concat([header,body]);
}
export class FrameReader {
  constructor(receive,max=64*1024*1024){this.receive=receive;this.max=max;this.header=Buffer.alloc(4);this.headerUsed=0;this.body=null;this.used=0;}
  push(chunk){
    let offset=0;
    while(offset<chunk.length){
      if(!this.body){const n=Math.min(4-this.headerUsed,chunk.length-offset);chunk.copy(this.header,this.headerUsed,offset,offset+n);this.headerUsed+=n;offset+=n;
        if(this.headerUsed<4)continue;const size=this.header.readUInt32LE();if(!size||size>this.max)throw new Error('Invalid native frame length');this.body=Buffer.alloc(size);this.used=0;}
      const n=Math.min(this.body.length-this.used,chunk.length-offset);chunk.copy(this.body,this.used,offset,offset+n);this.used+=n;offset+=n;
      if(this.used===this.body.length){let value;try{value=JSON.parse(this.body.toString('utf8'));}catch{throw new Error('Invalid native frame JSON');}
        this.body=null;this.used=0;this.headerUsed=0;this.receive(value);}
    }
  }
  end(){if(this.body||this.headerUsed)throw new Error('Incomplete native frame');}
}
export class BrowserRpc {
  constructor(input,output,{timeout=75000}={}){
    Object.assign(this,{input,output,timeout,pending:new Map(),sequence:0,closed:false});
    this.reader=new FrameReader(message=>this.receive(message));
    input.on('data',chunk=>{try{this.reader.push(chunk);}catch{this.close('Invalid browser protocol');this.onClose?.();}});
    input.on('end',()=>{this.close('Browser disconnected');this.onClose?.();});input.on('error',()=>{this.close('Browser input failed');this.onClose?.();});
    output.on('error',()=>{this.close('Browser output failed');this.onClose?.();});
  }
  send(value){if(this.closed)throw new Error('Browser disconnected');this.output.write(frame(value));}
  receive(message){
    if(message?.type!=='response'){this.onCommand?.(message);return;}
    const pending=this.pending.get(message.id);if(!pending)return;this.pending.delete(message.id);clearTimeout(pending.timer);
    if(message.error)pending.reject(new Error('Browser request failed'));else pending.resolve(message.result);
  }
  request(path,workspace){
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Browser request timed out'));},this.timeout);
      this.pending.set(id,{resolve,reject,timer});try{this.send({type:'request',id,path,workspace:workspace ?? null});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});
  }
  close(reason='Browser disconnected'){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}this.pending.clear();}
}
