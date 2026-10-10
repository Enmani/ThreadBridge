import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile,writeFile,access} from 'node:fs/promises';
import {fixture} from './fixtures.mjs';
import {encryptAuthSession} from '../scripts/capture-authsession.mjs';
import {prepareCapture,saveEncryptedSession,cleanupCapture} from '../scripts/encrypted-authsession.mjs';
import {encryptJson,decryptJson} from '../src/secure-transfer.mjs';

function browser(loggedIn=true) {
  return {location:{origin:'https://chatgpt.com'},crypto:webcrypto,atob,btoa,TextEncoder,AbortSignal,
    async fetch(url,options){assert.equal(url,'/api/auth/session');assert.equal(options.credentials,'include');return {ok:true,async json(){return loggedIn?{accessToken:'test-only-token',user:{email:'excluded@example.com'}}:{};}};}};
}
test('browser capture encrypts the token; only encrypted data crosses the tool boundary',async t=>{
  const f=await fixture(t),prepared=await prepareCapture(f.dir);try{
    const packet=await encryptAuthSession(prepared.publicKey,browser());assert.equal(JSON.stringify(packet).includes('test-only-token'),false);
    await writeFile(prepared.packetFile,JSON.stringify(packet));const saved=await saveEncryptedSession(prepared.keyFile,prepared.packetFile,prepared.destination);
    assert.equal(saved.saved,true);assert.deepEqual(JSON.parse(await readFile(prepared.destination,'utf8')),{accessToken:'test-only-token'});
    assert.equal(JSON.stringify(saved).includes('test-only-token'),false);
  }finally{await cleanupCapture(prepared.keyFile,prepared.packetFile);}
});
test('missing login and wrong origin fail without creating a credential file',async t=>{
  const f=await fixture(t),prepared=await prepareCapture(f.dir);try{
    await assert.rejects(encryptAuthSession(prepared.publicKey,browser(false)),/Sign in/);
    await assert.rejects(encryptAuthSession(prepared.publicKey,{location:{origin:'https://example.com'}}),/ChatGPT/);
    await assert.rejects(access(prepared.destination));
  }finally{await cleanupCapture(prepared.keyFile,prepared.packetFile);}
});
test('invalid packets preserve an existing session; capture cleanup removes temporary files',async t=>{
  const f=await fixture(t),prepared=await prepareCapture(f.dir);await writeFile(prepared.destination,'{"accessToken":"existing-test-token"}');
  await writeFile(prepared.packetFile,JSON.stringify({version:1,key:'bad',iv:'bad',cipher:'bad'}));
  await assert.rejects(saveEncryptedSession(prepared.keyFile,prepared.packetFile,prepared.destination),/capture size/);
  assert.equal(JSON.parse(await readFile(prepared.destination,'utf8')).accessToken,'existing-test-token');
  await cleanupCapture(prepared.keyFile,prepared.packetFile);await assert.rejects(access(prepared.keyFile));await assert.rejects(access(prepared.packetFile));
});
test('corrupted transfer and mismatched file paths fail without overwriting the session',async t=>{
  const f=await fixture(t),prepared=await prepareCapture(f.dir);try{
    const packet=await encryptAuthSession(prepared.publicKey,browser());const bytes=Buffer.from(packet.cipher,'base64');bytes[0]^=1;packet.cipher=bytes.toString('base64');
    await writeFile(prepared.packetFile,JSON.stringify(packet));await assert.rejects(saveEncryptedSession(prepared.keyFile,prepared.packetFile,prepared.destination),/could not be decrypted/);
    await assert.rejects(cleanupCapture(prepared.keyFile,prepared.keyFile),/paths/);await assert.rejects(access(prepared.destination));
  }finally{await cleanupCapture(prepared.keyFile,prepared.packetFile);}
});
test('compressed history transfers preserve long text and enforce decompressed size limits',async t=>{
  const f=await fixture(t),prepared=await prepareCapture(f.dir);try{
    const value={mapping:{a:{message:{content:{parts:['长聊天内容'.repeat(30000)]}}}}};
    const packet=await encryptJson(value,prepared.publicKey,{browser:{crypto:webcrypto,atob,btoa,TextEncoder,Response,Blob,CompressionStream},compress:true});
    const privateKey=await readFile(prepared.keyFile,'utf8');
    assert.deepEqual(decryptJson(packet,privateKey),value);assert.equal(packet.compression,'gzip');
    assert.ok(packet.cipher.length<5000);assert.throws(()=>decryptJson(packet,privateKey,{maxBytes:10000}),/could not be decrypted/);
    assert.throws(()=>decryptJson({...packet,compression:'unknown'},privateKey),/compression/);
  }finally{await cleanupCapture(prepared.keyFile,prepared.packetFile);}
});
