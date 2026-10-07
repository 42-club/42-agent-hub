import { sleep } from "workflow";
import { runCloudTick } from "../../server/cloud-runtime";

async function tick(roomId: string, generation: number) {
  "use step";
  return runCloudTick(roomId, generation);
}
// A failed provider call must never be repeated automatically and billed twice.
tick.maxRetries = 0;

export async function roomWorkflow(roomId: string, generation: number) {
  "use workflow";
  while (await tick(roomId, generation)) await sleep("1s");
}
