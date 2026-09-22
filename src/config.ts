/**
 * ~/.dash/config.json — the same file the Python CLI reads and writes.
 *
 * Keys: remote_url, api_key, default_batch_size, auth_url, device_secret.
 * A corrupt file is treated as empty, matching the Python behaviour, so a
 * half-written config never blocks `ml-dash login`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_API_URL = "https://api.dash.ml";

export class Config {
  readonly configDir: string;
  readonly configPath: string;
  private data: Record<string, unknown>;

  constructor(configDir?: string) {
    this.configDir = configDir ?? process.env.ML_DASH_CONFIG_DIR ?? path.join(homedir(), ".dash");
    this.configPath = path.join(this.configDir, "config.json");
    this.data = this.load();
  }

  private load(): Record<string, unknown> {
    if (!existsSync(this.configPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  save(): void {
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
  }

  get<T = unknown>(key: string, fallback?: T): T {
    return (this.data[key] as T) ?? (fallback as T);
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.save();
  }

  delete(key: string): void {
    if (key in this.data) {
      delete this.data[key];
      this.save();
    }
  }

  get remoteUrl(): string {
    return this.get<string>("remote_url", DEFAULT_API_URL);
  }
  get apiKey(): string | undefined {
    return this.get<string | undefined>("api_key", undefined);
  }
  get batchSize(): number {
    return this.get<number>("default_batch_size", 100);
  }
  get authUrl(): string | undefined {
    return this.get<string | undefined>("auth_url", undefined);
  }
  get deviceSecret(): string | undefined {
    return this.get<string | undefined>("device_secret", undefined);
  }
}
