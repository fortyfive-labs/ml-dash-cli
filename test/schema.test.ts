import test from 'node:test';
import assert from 'node:assert/strict';
import { cliInspectionSchema } from '../src/cli/schema.js';
import { commandLoaders } from '../src/cli/loaders.js';
import { managementActions } from '../src/managed/commands.js';
import { parseArgs } from '../src/cli/parser.js';
test('machine command grammar is identical to actual dispatch and parser option aliases',async()=>{
 const schema=await cliInspectionSchema();assert.deepEqual(schema.commands.map(c=>c.name).sort(),Object.keys(commandLoaders).sort());
 for(const command of schema.commands){const {spec}=await commandLoaders[command.name]();assert.deepEqual(command.options.map(o=>o.flags),spec.options.map(o=>o.flags));assert.deepEqual(command.actions,managementActions[command.name]??[]);for(const action of command.actions){assert.doesNotThrow(()=>parseArgs(spec,[action,'--json']));const op=command.operations.find(op=>op.id===`${command.name}.${action}`)!;assert.ok(op);for(const required of op.input.required)assert.ok(required in op.input.properties,`${op.id} unknown required field ${required}`);}}
});
