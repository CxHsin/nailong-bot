import { rm } from "node:fs/promises";
import { resolve } from "node:path";

export const MEMORY_INDEX_FILE = "memory.sqlite";
export const MEMORY_INITIALIZATION_DIR = "memory-initialization";
export async function invalidateMemoryIndex(dataDir: string) {
  await Promise.all([rm(resolve(dataDir, MEMORY_INDEX_FILE), { force: true }),
    rm(resolve(dataDir, MEMORY_INITIALIZATION_DIR, MEMORY_INDEX_FILE), { force: true })]);
}
