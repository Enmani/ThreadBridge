import {encryptJson} from '../src/secure-transfer.mjs';
// Executed inside the logged-in browser. Only an encrypted packet crosses the tool boundary.
export async function encryptAuthSession(publicKey,browser=globalThis.window) {
  if(browser?.location?.origin!=='https://chatgpt.com')throw new Error('Open a logged-in ChatGPT page first');
  const response=await browser.fetch('/api/auth/session',{credentials:'include',signal:browser.AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('Session request failed');
  const session=await response.json();
  if(typeof session?.accessToken!=='string'||!session.accessToken.trim())throw new Error('Sign in to ChatGPT in this browser first');
  return encryptJson({accessToken:session.accessToken},publicKey,{browser});
}
