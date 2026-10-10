import {indexWake,indexZoom,indexSearch,summaryTasks,saveSummary,updateIndex} from './chat-index.mjs';

export const indexTool={name:'chat_index',description:'Navigate a local binary tree of all archived message versions. Start with wake (bounded map), use search for exact text, zoom to two children or an original text chunk. tasks supplies bottom-up summary work for this AI; summarize only source data, then submit summary with id and generation. No model is called by the server. status.pending reports archives still being indexed. This tool never syncs remote history.',
  inputSchema:{type:'object',properties:{action:{type:'string',enum:['wake','zoom','search','tasks','summary','update']},id:{type:'string'},generation:{type:'integer',minimum:1},query:{type:'string'},summary:{type:'string'},budget:{type:'integer',minimum:1,maximum:64},limit:{type:'integer',minimum:1,maximum:1000}},required:['action'],additionalProperties:false}};
export function invokeIndex(store,args){
  const allowed={wake:['budget'],zoom:['id','generation'],search:['query','limit'],tasks:['limit'],summary:['id','generation','summary'],update:['limit']};
  if(!Object.hasOwn(allowed,args.action))throw new Error('Invalid index action');
  for(const key of Object.keys(args))if(key!=='action'&&!allowed[args.action].includes(key))throw new Error('Invalid argument for index action: '+key);
  switch(args.action){
    case 'wake':return indexWake(store,args);
    case 'zoom':return indexZoom(store,args);
    case 'search':return indexSearch(store,args);
    case 'tasks':return summaryTasks(store,args);
    case 'summary':return saveSummary(store,args);
    case 'update':return updateIndex(store,args);
  }
}
