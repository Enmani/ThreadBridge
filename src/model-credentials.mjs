import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,lstatSync,constants as fsConstants,openSync,closeSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const memoryKeys=new WeakMap();
const cache=new WeakMap();
function cached(store){if(!cache.has(store.db))cache.set(store.db,new Map());return cache.get(store.db);}
const cacheId=(store,id)=>JSON.stringify([store.accountName,id]);
export function forgetCredential(store,id){cached(store).delete(cacheId(store,id));}
function key(store){
  if(store.file===':memory:'){
    if(!memoryKeys.has(store.db))memoryKeys.set(store.db,randomBytes(32));return memoryKeys.get(store.db);
  }
  const file=store.file+'.model-key';
  try{const fd=openSync(file,fsConstants.O_WRONLY|fsConstants.O_CREAT|fsConstants.O_EXCL|fsConstants.O_NOFOLLOW,0o600);
    try{writeFileSync(fd,randomBytes(32));}finally{closeSync(fd);}
  }catch(e){if(e.code!=='EEXIST')throw e;}
  const stat=lstatSync(file);if(!stat.isFile()||(stat.mode&0o077))throw new Error('Private credential key required');
  const value=readFileSync(file);if(value.length!==32)throw new Error('Invalid credential key');return value;
}
function windows(value,protect){
  // The fixed command reads secret bytes from stdin, never command arguments or environment variables.
  const script=`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); `+
    `$r=[Security.Cryptography.ProtectedData]::${protect?'Protect':'Unprotect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
    {input:Buffer.from(value).toString('base64'),encoding:'utf8',timeout:10000,maxBuffer:65536,windowsHide:true});
  if(result.status!==0)throw new Error('Credential protection unavailable');return Buffer.from(result.stdout.trim(),'base64');
}
export function protectCredential(store,id,secret){
  if(!secret){forgetCredential(store,id);return null;}
  try{
    const value=Buffer.from(JSON.stringify({account:store.accountName,id,secret}));
    let credential;
    if(process.platform==='win32')credential='dpapi:'+windows(value,true).toString('base64');
    else{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(store),iv);cipher.setAAD(Buffer.from(store.accountName+':'+id));
      credential='aes:'+Buffer.concat([iv,cipher.update(value),cipher.final(),cipher.getAuthTag()]).toString('base64');}
    cached(store).set(cacheId(store,id),{credential,secret});return credential;
  }catch{throw Object.assign(new Error('Unable to protect model credential'),{status:500,code:'credential-store'});}
}
export function revealCredential(store,row){
  if(!row.credential)return '';
  try{
    if(row.account!==store.accountName)throw new Error('Credential namespace mismatch');
    const old=cached(store).get(cacheId(store,row.id));if(old?.credential===row.credential)return old.secret;
    const [type,encoded]=row.credential.split(':'),value=Buffer.from(encoded,'base64');let decoded;
    if(type==='dpapi'&&process.platform==='win32')decoded=windows(value,false);
    else if(type==='aes'&&process.platform!=='win32'){
      const cipher=createDecipheriv('aes-256-gcm',key(store),value.subarray(0,12));cipher.setAAD(Buffer.from(store.accountName+':'+row.id));
      cipher.setAuthTag(value.subarray(-16));decoded=Buffer.concat([cipher.update(value.subarray(12,-16)),cipher.final()]);
    }else throw new Error('Unsupported credential protection');
    const data=JSON.parse(decoded);if(data.account!==store.accountName||data.id!==row.id)throw new Error('Credential namespace mismatch');
    cached(store).set(cacheId(store,row.id),{credential:row.credential,secret:data.secret});return data.secret;
  }catch{throw Object.assign(new Error('Reconnect this model service'),{status:409,code:'credential-store'});}
}
