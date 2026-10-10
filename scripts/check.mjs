import {readdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for (const directory of ['src','scripts','test','extension','web']) for (const file of readdirSync(directory).filter(x=>/\.(mjs|js)$/.test(x))) {
  const target=`${directory}/${file}`;
  if (readFileSync(target,'utf8').split('\n').length>500) throw new Error(`${target} exceeds 500 lines`);
  const check=spawnSync(process.execPath,['--check',target],{stdio:'inherit'});if(check.status) process.exit(check.status);
}
const tests=readdirSync('test').filter(x=>x.endsWith('.test.mjs')).map(x=>`test/${x}`);
const test=spawnSync(process.execPath,['--test',...tests],{stdio:'inherit'});process.exit(test.status ?? 1);
