import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const output = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
if (dirname(output) !== root) throw new Error("Build output must be inside the project root");
await rm(output, { recursive: true, force: true });
