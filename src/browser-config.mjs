import {workerConfig} from './browser-worker.mjs';

export function hostConfigs(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid native host configuration');
  if(value.providers===undefined)return [workerConfig(value)];
  if(!Array.isArray(value.providers)||!value.providers.length||value.providers.length>3)throw new Error('Invalid provider configuration');
  const configs=value.providers.map(entry=>{
    if(!entry||typeof entry!=='object'||Array.isArray(entry)||Object.keys(entry).some(k=>!['provider','workspace','authuser'].includes(k)))throw new Error('Invalid provider configuration');
    // Workspace belongs to one platform; never inherit the legacy ChatGPT workspace.
    return workerConfig({...value,workspace:null,...entry});
  });
  if(new Set(configs.map(c=>c.provider)).size!==configs.length)throw new Error('Duplicate history providers');return configs;
}
