import {privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

// This function is also serialized into the browser; keep it self-contained.
export async function encryptJson(value,publicKey,{browser=globalThis.window,compress=false}={}) {
  const decode=s=>Uint8Array.from(browser.atob(s),c=>c.charCodeAt(0));
  const encode=data=>{const bytes=new Uint8Array(data);let s='';for(let i=0;i<bytes.length;i+=16384)s+=String.fromCharCode(...bytes.subarray(i,i+16384));return browser.btoa(s);};
  const recipient=await browser.crypto.subtle.importKey('spki',decode(publicKey),{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const secret=browser.crypto.getRandomValues(new Uint8Array(32)),iv=browser.crypto.getRandomValues(new Uint8Array(12));
  const key=await browser.crypto.subtle.importKey('raw',secret,'AES-GCM',false,['encrypt']);
  try {
    let plain=new browser.TextEncoder().encode(JSON.stringify(value));
    if(compress)plain=new Uint8Array(await new browser.Response(new browser.Blob([plain]).stream().pipeThrough(new browser.CompressionStream('gzip'))).arrayBuffer());
    const cipher=await browser.crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);
    const wrapped=await browser.crypto.subtle.encrypt('RSA-OAEP',recipient,secret);
    return {version:1,compression:compress?'gzip':'none',key:encode(wrapped),iv:encode(iv),cipher:encode(cipher)};
  }finally{secret.fill(0);}
}
export function decryptJson(packet,privateKey,{maxBytes=64*1024*1024}={}) {
  const decode=(value,min,max)=>{
    if(typeof value!=='string'||!/^[A-Za-z0-9+/]+={0,2}$/.test(value))throw new Error('Invalid capture encoding');
    const bytes=Buffer.from(value,'base64');if(bytes.length<min||bytes.length>max)throw new Error('Invalid capture size');return bytes;
  };
  if(packet?.version!==1)throw new Error('Unsupported capture packet');
  if(![undefined,'none','gzip'].includes(packet.compression))throw new Error('Unsupported capture compression');
  const wrapped=decode(packet.key,256,256),iv=decode(packet.iv,12,12),cipher=decode(packet.cipher,17,maxBytes);
  let plain;
  try {
    const key=privateDecrypt({key:privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},wrapped);
    try{const decoder=createDecipheriv('aes-256-gcm',key,iv);decoder.setAuthTag(cipher.subarray(-16));plain=Buffer.concat([decoder.update(cipher.subarray(0,-16)),decoder.final()]);}
    finally{key.fill(0);}
    if(packet.compression==='gzip'){const compressed=plain;plain=gunzipSync(compressed,{maxOutputLength:maxBytes});compressed.fill(0);}
  }catch{plain?.fill(0);throw new Error('Session transfer could not be decrypted');}
  try{return JSON.parse(plain.toString('utf8'));}catch{throw new Error('Invalid capture JSON');}finally{plain.fill(0);}
}
