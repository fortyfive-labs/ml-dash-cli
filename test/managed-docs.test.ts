import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { managementLoaders } from '../src/managed/commands.js';
import { parseArgs, type CommandSpec } from '../src/cli/parser.js';

test('owning managed guide command examples remain parseable against actual command specs',async()=>{
 const docs=readFileSync(new URL('../docs/MANAGED.md',import.meta.url),'utf8');let count=0;
 for(const line of docs.split('\n')){
  if(!line.startsWith('ml-dash '))continue;
  const args=line.split(/\s+/).slice(1);const command=args.shift()!;const loader=managementLoaders[command];assert.ok(loader,`Unknown documented command: ${command}`);
  const {spec}=await loader();assert.doesNotThrow(()=>parseArgs(spec as CommandSpec,args),line);count++;
 }
 assert.ok(count>=25,`Expected substantive command recipes, got ${count}`);
 assert.match(docs,/OWNERSHIP_LIFECYCLE_UNSUPPORTED/);assert.match(docs,/Source-backed storage is excluded/);
});
