/**
 * Shared command setup: which server to talk to, and with which credential.
 *
 * Resolution order matches the Python CLI: an explicit `--dash-url` beats
 * ~/.dash/config.json's `remote_url`, which beats the built-in default; and an
 * `api_key` written into the config beats the stored login token, so a
 * service-account config keeps working without a keychain.
 */
import { RemoteClient } from "../client.js";
import { Config, DEFAULT_API_URL } from "../config.js";
import { TokenStore } from "../auth/token-storage.js";

export interface ResolvedContext {
  config: Config;
  remoteUrl: string;
  apiKey?: string;
  /** Set when no credential was found and the reason is worth reporting. */
  unreadableReason?: string;
}

export function resolveContext(args: { dash_url?: unknown }): ResolvedContext {
  const config = new Config();
  const remoteUrl =
    (typeof args.dash_url === "string" ? args.dash_url : undefined) ||
    config.remoteUrl ||
    DEFAULT_API_URL;

  if (config.apiKey) return { config, remoteUrl, apiKey: config.apiKey };

  const loaded = new TokenStore(config.configDir).load();
  return {
    config,
    remoteUrl,
    apiKey: loaded.token ?? undefined,
    unreadableReason: loaded.unreadableReason,
  };
}

export function makeClient(ctx: ResolvedContext, namespace?: string): RemoteClient {
  return new RemoteClient(ctx.remoteUrl, namespace, ctx.apiKey);
}

/** The single message every command uses when there is no usable credential. */
export function notAuthenticatedMessage(ctx: ResolvedContext): string {
  const base = "Not authenticated. Run 'ml-dash login' to authenticate.";
  return ctx.unreadableReason ? `${base}\n\n${ctx.unreadableReason}` : base;
}
