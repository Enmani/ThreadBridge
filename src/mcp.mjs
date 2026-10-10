import readline from 'node:readline';
import {indexTool,invokeIndex} from './chat-index-interface.mjs';
import {integer,ids,runSync} from './service.mjs';

const tools=[
  indexTool,
  {name:'list_threads',description:'List the local thread directory with IDs, update times, archive coverage and pending state. Does not request remote chat content.',inputSchema:{type:'object',properties:{query:{type:'string'},page:{type:'integer',minimum:1,maximum:1000000},limit:{type:'integer',minimum:1,maximum:200}},additionalProperties:false}},
  {name:'sync_history',description:'Discover active, archived and project chats, then persist new or changed raw trees.',inputSchema:{type:'object',properties:{full:{type:'boolean'},refresh:{type:'boolean'},batch:{type:'boolean'},concurrency:{type:'integer',minimum:1,maximum:8}},additionalProperties:false}},
  {name:'search_history',description:'Search locally stored message text across all stored branches.',inputSchema:{type:'object',properties:{query:{type:'string'},limit:{type:'integer',minimum:1,maximum:100}},required:['query'],additionalProperties:false}},
  {name:'fetch_threads',description:'Read local archives with explicit coverage: full-tree, bounded-text, page-text, export-text. Without a complete/native snapshot, an imported text archive is primary, and browserArchive may supplement it. import-* IDs are local, not original message IDs. revision selects a historical complete/native snapshot.',inputSchema:{type:'object',properties:{ids:{type:'array',items:{type:'string'},maxItems:10},revision:{type:'integer',minimum:1}},required:['ids'],additionalProperties:false}},
  {name:'get_changes',description:'Read changes after this consumer acknowledgement. Reading alone never acknowledges.',inputSchema:{type:'object',properties:{consumer:{type:'string'},limit:{type:'integer',minimum:1,maximum:500}},required:['consumer'],additionalProperties:false}},
  {name:'ack_changes',description:'Acknowledge a previously offered change position after successful processing.',inputSchema:{type:'object',properties:{consumer:{type:'string'},through:{type:'integer',minimum:0}},required:['consumer','through'],additionalProperties:false}},
  {name:'get_sync_status',description:'Inspect coverage, pending work and last directory scan.',inputSchema:{type:'object',properties:{},additionalProperties:false}},
];
function validate(name,args) {
  const schema=tools.find(t=>t.name===name)?.inputSchema;if(!schema)throw new Error('Unknown tool');
  if(!args || typeof args!=='object' || Array.isArray(args))throw new Error('Tool arguments must be an object');
  for(const key of Object.keys(args)){const spec=schema.properties[key];if(!spec)throw new Error(`Unknown argument: ${key}`);
    if(spec.type==='integer'){integer(args[key],undefined,spec.minimum,spec.maximum ?? Number.MAX_SAFE_INTEGER);if(typeof args[key]!=='number')throw new Error(`Invalid type: ${key}`);}
    else if(spec.type==='array'){if(!Array.isArray(args[key]) || args[key].length>spec.maxItems)throw new Error('Invalid ID list');ids(args[key]);}
    else if(typeof args[key]!==spec.type)throw new Error(`Invalid type: ${key}`);}
  for(const key of schema.required ?? [])if(args[key]===undefined)throw new Error(`Missing argument: ${key}`);
}
async function invoke(store,name,args,options) {
  validate(name,args);
  if(options.localOnly && name==='sync_history')throw new Error('This MCP uses local data only. The browser extension handles background sync.');
  switch(name) {
    case 'chat_index':return invokeIndex(store,args);
    case 'list_threads':return store.listThreads(args);
    case 'sync_history':return runSync(store,{...options,...args});
    case 'search_history':return store.search(args.query,args.limit);
    case 'fetch_threads':return args.ids.map(id=>({id,...store.read(id,args.revision)}));
    case 'get_changes':return store.changes(args.consumer,args.limit);
    case 'ack_changes':return store.ack(args.consumer,args.through);
    case 'get_sync_status':return store.status();
  }
}
export async function serve(store,options={}) {
  const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  // Sequential dispatch prevents overlapping syncs and keeps consumer offer/ack ordering explicit.
  for await(const line of input) {
    let request;
    try {
      if(Buffer.byteLength(line)>1024*1024)throw new Error('MCP input exceeds 1 MiB');request=JSON.parse(line);
      if(request.jsonrpc!=='2.0' || typeof request.method!=='string')throw new Error('Invalid JSON-RPC');
      if(request.id===undefined)continue;
      let result;
      switch(request.method) {
        case 'initialize':result={protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(request.params?.protocolVersion)?request.params.protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'threadbridge',version:'0.9.0'}};break;
        case 'ping':result={};break;
        case 'tools/list':result={tools:options.localOnly?tools.filter(t=>t.name!=='sync_history'):tools};break;
        case 'tools/call':
          try{result={content:[{type:'text',text:JSON.stringify(await invoke(store,request.params?.name,request.params?.arguments ?? {},options))}]};}
          catch(e){result={isError:true,content:[{type:'text',text:e.message}]};}break;
        default:process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}})+'\n');continue;
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
    } catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id ?? null,error:{code:-32600,message:request?e.message:'Invalid JSON request'}})+'\n');}
  }
}
