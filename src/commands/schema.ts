import type { CommandSpec, ParsedArgs } from '../cli/parser.js';
import { cliInspectionSchema } from '../cli/schema.js';
export const spec:CommandSpec={name:'schema',help:'Print machine-readable local command and output schemas without login or network',options:[{flags:['--json'],dest:'json',boolean:true,help:'Stable success envelope containing local command schemas'},{flags:['--schema-version'],dest:'schema_version',choices:['1'],help:'Supported local schema format version (default 1)'}]};
export async function run(_args:ParsedArgs):Promise<number>{console.log(JSON.stringify({ok:true,data:await cliInspectionSchema()},null,2));return 0;}
