import { startProxy } from "./dist/proxy.js";
import { readStoredCursorAuth } from "./dist/auth/opencode-auth-store.js";
import { resolveConfigModels } from "./dist/provider/config-models.js";

const auth = readStoredCursorAuth();
if (!auth || !auth.access) {
  console.error("Cursor auth not found or expired in auth.json");
  process.exit(1);
}

process.env.OPENCODE_CURSOR_PROXY_PORT = "40000";

const models = await resolveConfigModels();
const port = await startProxy(async () => auth.access, models);
console.log(`[Cursor Proxy] Live and listening on http://127.0.0.1:${port}/v1`);

// 保持进程常驻
setInterval(() => {}, 1000 * 60);
