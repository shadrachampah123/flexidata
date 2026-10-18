import { readFile } from "node:fs/promises";
import { runRestorePlanPreflight } from "./restore-plan-preflight-core";

void runRestorePlanPreflight(process.argv.slice(2), {
  readPlanFile: path => readFile(path, "utf8"),
  writeLine: line => console.log(line),
}).then(exitCode => {
  process.exitCode = exitCode;
}).catch(() => {
  console.error("BLOCKED: unexpected local preflight error. No restore or cleanup was run.");
  process.exitCode = 1;
});
