import { createCoordinator } from "./coordinator-runtime";
const token=process.env.HUB_INTERNAL_TOKEN;
if(!token)throw new Error("请使用 npm run dev 启动完整应用");
const runtime=await createCoordinator({token,dataDir:process.env.HUB_DATA_DIR||".data"}).catch((error: unknown)=>{
  console.error(`42 Agent Hub · 启动失败：${error instanceof Error ? error.message : "无法启动房间服务"}`);
  process.exit(1);
});
runtime.server.listen(Number(process.env.HUB_COORDINATOR_PORT||4317),"127.0.0.1",()=>console.log("42 Agent Hub · 房间服务已就绪"));
let closing=false;
async function stop(code=0){if(closing)return;closing=true;try{await runtime.close();}finally{process.exit(code);}}
process.on("SIGTERM",()=>void stop());process.on("SIGINT",()=>void stop());
runtime.server.on("error",(error)=>{console.error(`42 Agent Hub · 监听失败：${error.message}`);void stop(1);});
process.on("uncaughtException",()=>void stop(1));process.on("unhandledRejection",()=>void stop(1));
