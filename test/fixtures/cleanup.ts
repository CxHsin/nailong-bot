import { rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export async function closeFixture(options: { server: Server; dir: string; shutdown: () => Promise<void> }) {
  const target = resolve(options.dir);
  if (dirname(target) !== resolve(tmpdir())) throw new Error("集成测试只能清理直接创建的临时目录");
  try { await options.shutdown(); }
  finally {
    options.server.closeAllConnections();
    try { await new Promise<void>((resolve, reject) => options.server.close((error) => error ? reject(error) : resolve())); }
    finally { await rm(target, { recursive: true, force: true }); }
  }
}
