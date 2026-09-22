import type { CommandSpec } from "../cli/parser.js";
import { VERSION } from "../version.js";

export const spec: CommandSpec = {
  name: "version",
  help: "Show ml-dash version",
  options: [],
};

export function run(): number {
  console.log(`ml-dash ${VERSION}`);
  return 0;
}
