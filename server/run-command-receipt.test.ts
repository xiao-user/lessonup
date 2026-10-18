import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { MemoryLessonRepository } from "./repositories/memory-repository.js";
import type { LessonPlan } from "./domain.js";
const owner = "00000000-0000-4000-8000-00000000000a";
const commandId = "22222222-2222-4222-8222-222222222222";
async function setup() {
  const repository = new MemoryLessonRepository();
  const document = Object.fromEntries(["unit","period","totalPeriods","topic","objectives","knowledgePoints","continuity","focus","preparation","process","assessment","homework","board","reflection"].map(key => [key,"test"])) as LessonPlan;
  await repository.importNotebookGraph(owner,[{id:"n",title:"test",className:"test",year:"2026",subject:"语文",files:[{id:"f",title:"test",pages:1,lessonPlan:document}]}]);
  const {thread,branch} = await repository.createThread(owner,{notebookId:"n",lessonFileId:"f"});
  await repository.createRun({id:"run",ownerId:owner,threadId:thread.id,branchId:branch.id,model:"configured",status:"queued",clientCommandId:commandId});
  return {repository,thread,branch,app:createApp(repository,{agent:null})};
}
describe("run command receipt", () => {
  it("reads only matching command metadata and never executes another run", async () => {
    const {repository,thread,branch,app} = await setup();const create=vi.spyOn(repository,"createRun");
    const r=await app.request(`/api/agent/threads/${thread.id}/run-commands/${commandId}?branchId=${branch.id}`,{headers:{"x-lessonup-user":owner}});
    expect(r.status).toBe(200);expect(await r.json()).toEqual({run:{id:"run",threadId:thread.id,branchId:branch.id,status:"queued",clientCommandId:commandId}});expect(create).not.toHaveBeenCalled();
  });
  it("keeps missing commands unknown and enforces owner/thread/branch scope", async () => {
    const {thread,branch,app}=await setup();
    const path=`/api/agent/threads/${thread.id}/run-commands/${commandId}?branchId=${branch.id}`;
    expect((await app.request(path,{headers:{"x-lessonup-user":"00000000-0000-4000-8000-00000000000b"}})).status).toBe(403);
    expect((await app.request(path.replace(branch.id,"other"),{headers:{"x-lessonup-user":owner}})).status).toBe(403);
    const missing=await app.request(path.replace(commandId,"33333333-3333-4333-8333-333333333333"),{headers:{"x-lessonup-user":owner}});
    expect(await missing.json()).toEqual({run:null});
  });
});
