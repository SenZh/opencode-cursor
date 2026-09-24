/**
 * OpenCode Cursor Auth Plugin
 *
 * Enables using Cursor models (Claude, GPT, etc.) inside OpenCode via:
 * 1. Browser-based OAuth login to Cursor
 * 2. Local proxy translating OpenAI format → Cursor gRPC protocol
 */
import type { Hooks, Plugin, PluginInput } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";
import os from "os";
import {
  startCursorBrowserLogin,

  getPendingCursorLogin,
  waitForCursorBrowserLogin,
} from "./auth-login.js";
import {
  CURSOR_SELECTION_HEADER,
  encodeCursorModelSelection,
} from "./model-selection.js";
import { clearModelCache, resolveCursorModelSelection, type CursorModel } from "./models.js";
import { resolveConfigModels } from "./provider/config-models.js";
import { loadCursorRuntime } from "./provider/credential-runtime.js";
import { ensureCursorProviderConfig } from "./provider/provider-config.js";
import { getCursorProxyBaseUrl, startProxy, updateProxyModels } from "./proxy.js";
import { readStoredCursorAuth, writeStoredCursorAuth } from "./auth/opencode-auth-store.js";
import { ensureValidAccessToken } from "./auth/credential-manager.js";
import {
  CURSOR_PROVIDER_ID,
  CURSOR_VARIANT_OPTION,
} from "./shared/constants.js";

/**
 * OpenCode plugin that provides Cursor authentication and model access.
 * Register in opencode.json: { "plugin": ["@openchamber/opencode-cursor"] }
 */
export const CursorAuthPlugin: Plugin = async (
  input: PluginInput,
): Promise<Hooks> => {
  let modelCatalog: CursorModel[] = [];
  const rememberModels = (models: CursorModel[]) => {
    modelCatalog = models;
  };

  /**
   * Bind the local proxy early (ephemeral port) so the static provider
   * `options.baseURL` OpenCode reads from config points at a live listener.
   * Auth/token wiring is upgraded later by `loadCursorRuntime`.
   */
  async function ensureProxyForConfig(
    models: CursorModel[],
  ): Promise<string> {
    const existing = getCursorProxyBaseUrl();
    if (existing) return existing;
    const port = await startProxy(async () => {
      throw new Error("Cursor proxy is not authenticated yet");
    }, models);
    return `http://localhost:${port}/v1`;
  }

  return {
    // Newer OpenCode releases build the model catalog from statically declared
    // `config.provider.<id>` entries. Seed a concrete `cursor` provider so it
    // always appears; dynamic hooks refine connection details at runtime.
    async config(config) {
      const models = await resolveConfigModels();
      rememberModels(models);
      const baseURL = await ensureProxyForConfig(models);
      ensureCursorProviderConfig(config, models, baseURL);
    },

    "chat.headers": async (hookInput, output) => {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return;
      const messageModel = hookInput.message.model as typeof hookInput.message.model & {
        variant?: unknown;
      };
      const variant =
        typeof messageModel.variant === "string" ? messageModel.variant : undefined;
      const selected = resolveCursorModelSelection(
        modelCatalog,
        hookInput.model.id,
        variant,
      );
      if (selected) {
        output.headers[CURSOR_SELECTION_HEADER] =
          encodeCursorModelSelection(selected);
      }
    },

    "chat.params": async (hookInput, output) => {
      if (hookInput.model.providerID !== CURSOR_PROVIDER_ID) return;
      // Route the selected Cursor variant through a private local header —
      // do not leak OpenCode reasoning defaults or our marker into the SDK body.
      delete output.options.reasoningEffort;
      delete output.options[CURSOR_VARIANT_OPTION];
    },

    provider: {
      id: CURSOR_PROVIDER_ID,
      async models(provider, ctx) {
        const runtime = await loadCursorRuntime(
          input,
          async () => ctx.auth,
          provider,
          rememberModels,
        );
        return runtime?.providerModels ?? {};
      },
    },

    auth: {
      provider: CURSOR_PROVIDER_ID,

      async loader(getAuth, provider) {
        const runtime = await loadCursorRuntime(
          input,
          getAuth,
          provider,
          rememberModels,
        );
        if (!runtime) return {};

        return {
          baseURL: `http://localhost:${runtime.port}/v1`,
          apiKey: "cursor-proxy",
          async fetch(
            requestInput: RequestInfo | URL,
            init?: RequestInit,
          ) {
            stripAuthorizationHeader(init);
            return fetch(requestInput, init);
          },
        };
      },

      methods: [
        {
          type: "oauth",
          label: "Login with Cursor",
          async authorize() {
            // Reuse the headless browser login started by the config hook so
            // OpenChamber / CLI show one URL and share one poll session.
            let pending = getPendingCursorLogin();
            if (!pending || pending.completed) {
              pending = await startCursorBrowserLogin();
            }

            return {
              url: pending.url,
              instructions:
                "Open the URL below in your browser to authorize Cursor (same as `opencode auth login`). After you approve access, return here and click Complete — the live model list will load automatically. No API key is required.",
              method: "auto" as const,
              async callback() {
                const tokens = await waitForCursorBrowserLogin();
                clearModelCache();
                return {
                  type: "success" as const,
                  refresh: tokens.refresh,
                  access: tokens.access,
                  expires: tokens.expires,
                };
              },
            };
          },
        },
      ],
    },
  };
};

/** Remove Authorization so the local proxy does not forward a dummy API key. */
function stripAuthorizationHeader(init?: RequestInit): void {
  if (!init?.headers) return;
  if (init.headers instanceof Headers) {
    init.headers.delete("authorization");
  } else if (Array.isArray(init.headers)) {
    init.headers = init.headers.filter(
      ([key]) => key.toLowerCase() !== "authorization",
    );
  } else {
    delete (init.headers as Record<string, string>)["authorization"];
    delete (init.headers as Record<string, string>)["Authorization"];
  }
}

/**
 * OpenCode 2.0 Plugin Setup Hook
 */
async function setupV2(ctx: any): Promise<void> {
  // 1. 【立即启动本地 Proxy】绝不等待耗时的模型发现，确保端口第一时间处于监听状态！
  let baseURL = getCursorProxyBaseUrl();
  let proxyPortNumber: number | undefined;

  if (!baseURL) {
    try {
      proxyPortNumber = await startProxy(async () => {
        const stored = readStoredCursorAuth();
        if (stored) {
          try {
            const token = await ensureValidAccessToken({
              auth: stored,
              persist: writeStoredCursorAuth,
            });
            if (token) return token;
          } catch {}
          if (stored.access) return stored.access;
        }
        throw new Error("Cursor proxy is not authenticated yet");
      }, []);
      baseURL = `http://localhost:${proxyPortNumber}/v1`;
    } catch (e: any) {
      console.error("[opencode-cursor] Immediate startProxy failed:", e?.message || e);
    }
  }

  // 2. 异步进行模型发现，避免阻塞服务启动
  let modelCatalog: CursorModel[] = [];
  try {
    modelCatalog = await resolveConfigModels();
    if (modelCatalog.length > 0) {
      updateProxyModels(modelCatalog);
    }
  } catch (e) {
    // fallback
  }

  // 2. 注入 Provider 与 Models
  if (ctx.provider && typeof ctx.provider.transform === "function") {
    ctx.provider.transform((providers: any) => {
      try {
        // V2 Editor 模式: providers.update
        if (typeof providers.update === "function") {
          providers.update(CURSOR_PROVIDER_ID, (p: any) => {
            p.name = p.name || "Cursor";
            p.activation = "enabled";
            p.package = p.package || "aisdk:@ai-sdk/openai-compatible";
            p.settings = p.settings || {};
            p.settings.baseURL = baseURL;
            p.options = p.options || {};
            p.options.baseURL = baseURL;
          });
        }

        // V2 Editor 模式: providers.models.update
        if (providers?.models && typeof providers.models.update === "function") {
          for (const m of modelCatalog) {
            providers.models.update(CURSOR_PROVIDER_ID, m.id, (modelDef: any) => {
              modelDef.name = m.name || m.id;
              if (m.contextWindow || m.maxTokens) {
                modelDef.limit = {
                  context: m.contextWindow,
                  output: m.maxTokens,
                };
              }
              if (m.reasoning !== undefined) {
                modelDef.reasoning = m.reasoning;
              }
            });
          }
        }

        // 对象/字典模式兜底
        if (providers && typeof providers === "object" && !providers.update) {
          const existing = providers[CURSOR_PROVIDER_ID] || {};
          const existingOptions = existing.options || existing.settings || {};
          const existingModels = existing.models || {};

          const modelMap: Record<string, any> = { ...existingModels };
          for (const m of modelCatalog) {
            modelMap[m.id] = {
              name: m.name || m.id,
              limit: {
                context: m.contextWindow || 131072,
                output: m.maxTokens || 8192,
              },
              reasoning: m.reasoning,
              ...(existingModels[m.id] || {}),
            };
          }

          providers[CURSOR_PROVIDER_ID] = {
            ...existing,
            name: existing.name || "Cursor",
            npm: existing.npm || existing.package || "@ai-sdk/openai-compatible",
            options: {
              ...existingOptions,
              baseURL,
              includeUsage: true,
            },
            settings: {
              ...(existing.settings || {}),
              baseURL,
            },
            models: modelMap,
          };
        }
      } catch (err) {}
    });
  }

  // 3. 挂载 Session 请求钩子
  if (ctx.session && typeof ctx.session.hook === "function") {
    ctx.session.hook("model.request", (event: any) => {
      if (event?.providerID !== CURSOR_PROVIDER_ID && event?.model?.providerID !== CURSOR_PROVIDER_ID) return;
      const modelId = event.model?.id || event.modelID;
      const variant = typeof event.variant === "string" ? event.variant : undefined;
      const selected = resolveCursorModelSelection(modelCatalog, modelId, variant);
      if (selected && event.headers) {
        event.headers[CURSOR_SELECTION_HEADER] = encodeCursorModelSelection(selected);
      }
    });

    ctx.session.hook("context", (event: any) => {
      if (event?.providerID !== CURSOR_PROVIDER_ID && event?.model?.providerID !== CURSOR_PROVIDER_ID) return;
      if (event.options) {
        delete event.options.reasoningEffort;
        delete event.options[CURSOR_VARIANT_OPTION];
      }
    });
  }
}

const pluginExport = Object.assign(
  async function (input: PluginInput): Promise<Hooks> {
    return CursorAuthPlugin(input);
  },
  {
    id: "cursor",
    setup: setupV2,
    server: CursorAuthPlugin,
  },
);

export default pluginExport;
