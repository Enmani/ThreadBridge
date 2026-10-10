import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,unlink,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {encryptAuthSession} from './capture-authsession.mjs';
import {encryptJson,decryptJson} from '../src/secure-transfer.mjs';

export async function prepareCapture(directory) {
  const dir=path.resolve(directory);await mkdir(dir,{recursive:true});const id=randomUUID();
  const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'der'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const keyFile=path.join(dir,`.authcapture-${id}.pem`),packetFile=path.join(dir,`.authcapture-${id}.json`);
  await writeFile(keyFile,pair.privateKey,{mode:0o600,flag:'wx'});
  const browserFunction='async function(publicKey,browser=globalThis.window){const encryptJson='+encryptJson.toString()+';return ('+encryptAuthSession.toString()+')(publicKey,browser);}';
  return {keyFile,packetFile,destination:path.join(dir,'authsession.json'),publicKey:pair.publicKey.toString('base64'),browserFunction};
}
function verifyPaths(keyFile,packetFile,destination) {
  const match=/^\.authcapture-([0-9a-f-]{36})\.pem$/.exec(path.basename(keyFile));
  if(!match||path.basename(packetFile)!==`.authcapture-${match[1]}.json`||path.dirname(keyFile)!==path.dirname(packetFile))throw new Error('Invalid capture file paths');
  if(destination&&(path.dirname(destination)!==path.dirname(keyFile)||path.basename(destination)!=='authsession.json'))throw new Error('Invalid session destination');
}
async function remove(file) {try{await unlink(file);}catch(e){if(e.code!=='ENOENT')throw e;}}
export async function cleanupCapture(keyFile,packetFile) {
  verifyPaths(keyFile,packetFile);await remove(keyFile);await remove(packetFile);
}
export async function saveEncryptedSession(keyFile,packetFile,destination) {
  verifyPaths(keyFile,packetFile,destination);const raw=await readFile(packetFile,'utf8');
  if(raw.length>512*1024)throw new Error('Capture packet exceeds size limit');
  let packet;try{packet=JSON.parse(raw);}catch{throw new Error('Invalid capture packet JSON');}
  const session=decryptJson(packet,await readFile(keyFile,'utf8'),{maxBytes:256*1024});
  if(typeof session.accessToken!=='string'||!session.accessToken.trim()||/[\r\n]/.test(session.accessToken))throw new Error('Session has no valid accessToken');
  const temporary=path.join(path.dirname(destination),`.authsession-${randomUUID()}.tmp`);let created=false;
  try {
    await writeFile(temporary,JSON.stringify({accessToken:session.accessToken},null,2)+'\n',{mode:0o600,flag:'wx'});created=true;
    await rename(temporary,destination);created=false;return {ok:true,saved:true,path:destination};
  }finally{if(created)await remove(temporary);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const [,,command,...args]=process.argv;
  try {
    if(command==='prepare')console.log(JSON.stringify(await prepareCapture(args[0] ?? 'data')));
    else if(command==='finish') {try{console.log(JSON.stringify(await saveEncryptedSession(...args)));}finally{await cleanupCapture(args[0],args[1]);}}
    else if(command==='cleanup'){await cleanupCapture(args[0],args[1]);console.log(JSON.stringify({ok:true,cleaned:true}));}
    else throw new Error('Expected prepare, finish or cleanup');
  }catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
}
