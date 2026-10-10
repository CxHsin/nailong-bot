import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sourceBuildIdentity } from "../dist/src/runtime/build-identity.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const identity = await sourceBuildIdentity(root);
await writeFile(new URL("../dist/build-info.json", import.meta.url), JSON.stringify({ ...identity, mode: "build", builtAt: new Date().toISOString() }) + "\n");
