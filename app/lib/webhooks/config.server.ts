import { appEnv, type AppEnv } from "~/lib/env.server";

export interface SvixConfig {
  token: string;
  appId: string;
}

/** Null unless BOTH values exist. A half-configured Svix driver stays off. */
export function svixConfig(env: AppEnv = appEnv()): SvixConfig | null {
  if (!env.SVIX_TOKEN || !env.SVIX_APP_ID) return null;
  return { token: env.SVIX_TOKEN, appId: env.SVIX_APP_ID };
}

/** The single driver-selection seam for emitters and the Integrations UI. */
export function webhookDriver(env: AppEnv = appEnv()): "builtin" | "svix" {
  return svixConfig(env) ? "svix" : "builtin";
}
