import { KnowledgeIndexWorker } from "./worker.js";

const worker = new KnowledgeIndexWorker();
const stop = worker.start();

const shutdown = () => {
  stop();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
