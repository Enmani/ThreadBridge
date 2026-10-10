// Persist before forwarding, delete only after the native host confirms a SQLite commit.
export class ArchiveOutbox {
  constructor(factory=indexedDB){this.factory=factory;this.opening=null;}
  open(){
    if(!this.opening)this.opening=new Promise((resolve,reject)=>{
      const request=this.factory.open('threadbridge-browser-outbox',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('captures',{keyPath:'key',autoIncrement:true});
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('local-storage-failed'));
    }).catch(error=>{this.opening=null;throw error;});
    return this.opening;
  }
  async transact(mode,action){
    const db=await this.open();return new Promise((resolve,reject)=>{
      const transaction=db.transaction('captures',mode),store=transaction.objectStore('captures');let result,error;
      transaction.oncomplete=()=>resolve(result);transaction.onerror=transaction.onabort=()=>reject(error ?? new Error('local-storage-failed'));
      action(store,value=>{result=value;},value=>{error=value;transaction.abort();});
    });
  }
  enqueue(payload){
    const bytes=new TextEncoder().encode(JSON.stringify(payload)).length;
    if(bytes>32*1024*1024)throw new Error('capture-too-large');
    return this.transact('readwrite',(store,result,fail)=>{
      const scan=store.getAll();scan.onsuccess=()=>{
        if(scan.result.length>=100 || scan.result.reduce((n,r)=>n+r.bytes,0)+bytes>64*1024*1024)return fail(new Error('local-queue-full'));
        const request=store.add({payload,bytes,created:Date.now()});request.onsuccess=()=>result(request.result);
      };
    });
  }
  first(){return this.transact('readonly',(store,result)=>{const request=store.openCursor();request.onsuccess=()=>{
    const cursor=request.result;if(cursor?.value.deferred)cursor.continue();else result(cursor?.value ?? null);
  };});}
  defer(key){return this.transact('readwrite',store=>{const request=store.get(key);request.onsuccess=()=>{if(request.result)store.put({...request.result,deferred:true});};});}
  resetDeferred(){return this.transact('readwrite',store=>{const request=store.openCursor();request.onsuccess=()=>{const cursor=request.result;
    if(cursor){if(cursor.value.deferred)cursor.update({...cursor.value,deferred:false});cursor.continue();}
  };});}
  remove(key){return this.transact('readwrite',store=>store.delete(key));}
}
