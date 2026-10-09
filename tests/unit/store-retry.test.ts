import test from 'node:test';
import assert from 'node:assert/strict';
import {replaceSnapshot} from '../../server/paper/store';

test('atomic snapshot replacement retries transient Windows file locks without touching the destination',async()=>{
  let calls=0;const paths:string[][]=[];
  await replaceSnapshot('snapshot.tmp','project.json',(async(from,to)=>{
    paths.push([String(from),String(to)]);if(++calls<3)throw Object.assign(Error('locked'),{code:'EPERM'});
  }) as typeof import('node:fs/promises').rename);
  assert.equal(calls,3);assert.ok(paths.every(p=>p[0]==='snapshot.tmp'&&p[1]==='project.json'));
});
test('non-transient snapshot failures surface immediately',async()=>{
  let calls=0;await assert.rejects(replaceSnapshot('snapshot.tmp','project.json',(async()=>{calls++;throw Object.assign(Error('disk failure'),{code:'EIO'});}) as typeof import('node:fs/promises').rename),/disk failure/);
  assert.equal(calls,1);
});
