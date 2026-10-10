import path from 'node:path';
import {parseArgs} from 'node:util';
import {Store} from './store.mjs';
import {createDashboard} from './dashboard-server.mjs';

const {values}=parseArgs({options:{db:{type:'string'},account:{type:'string'},port:{type:'string'}}});
const port=Number(values.port ?? 17321);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid dashboard port');
const root=new Store(path.resolve(values.db??'data/history.sqlite'),values.account??'personal'),stores=new Map(['chatgpt','claude','gemini'].map(provider=>[provider,root.scope(provider)])),server=createDashboard(stores);
const dispose=()=>root.close();
server.on('error',()=>{process.stderr.write('Dashboard could not start; check the port and database.\n');dispose();process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`ThreadBridge dashboard: http://127.0.0.1:${port}`));
const close=()=>server.close(()=>{dispose();process.exit(0);});process.on('SIGINT',close);process.on('SIGTERM',close);
