import { sleep } from "workflow";
import { runCloudTick } from "../../server/cloud-runtime";

async function tick(roomId: string, generation: number) {
  "use step";
  return runCloudTick(roomId, generation);
}
// The worker owns bounded model retries. Never replay a whole phase or its saved actions.
tick.maxRetries = 0;

export async function roomWorkflow(roomId: string, generation: number) {
  "use workflow";
  while (await tick(roomId, generation)) await sleep("1s");
}
