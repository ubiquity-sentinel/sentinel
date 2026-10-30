import { join, resolve } from "node:path";
import {
  decoder,
  digest,
  encoder,
  type Evidence,
  type Observation,
} from "./telemetry-types.ts";

/** Reject credential-shaped content instead of changing bytes used by native proofs. */
export function hasSecret(text: string): boolean {
  return /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{24,})\b/
    .test(text) ||
    /(?:authorization["']?\s*[:=]\s*["']?\s*(?:bearer|token)\s+)[A-Za-z0-9._-]{16,}/i
      .test(text) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text);
}
function sensitive(bytes: Uint8Array): boolean {
  const text = decoder.decode(bytes);
  if (hasSecret(text)) return true;
  try {
    const value = JSON.parse(text);
    return value?.encoding === "base64" && typeof value.content === "string" &&
      hasSecret(atob(value.content.replace(/\s/g, "")));
  } catch {
    return false;
  }
}
export function safeError(status: number, input = ""): string {
  if (hasSecret(input)) return "credential-shaped response refused";
  if (status === 404 || status === 410) {
    return `HTTP ${status}: unavailable or expired`;
  }
  if (status === 401 || status === 403) {
    return `HTTP ${status}: authentication or access unavailable`;
  }
  return status === 0
    ? "request failed or timed out"
    : `HTTP ${status}: request unavailable`;
}

export class Archive {
  readonly root: string;
  private lock: Deno.FsFile | null = null;
  private lockToken = "";
  constructor(root: string) {
    this.root = resolve(root);
  }

  async open(): Promise<void> {
    await Deno.mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      this.lock = await Deno.open(join(this.root, "lock.json"), {
        write: true,
        createNew: true,
        mode: 0o600,
      });
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        throw new Error(
          `Archive locked: ${
            join(this.root, "lock.json")
          }; inspect its owner before manual recovery`,
        );
      }
      throw error;
    }
    this.lockToken = crypto.randomUUID();
    try {
      await this.lock.write(
        encoder.encode(
          JSON.stringify({
            token: this.lockToken,
            pid: Deno.pid,
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      await this.lock.sync();
      for (const path of ["blobs", "observations", "sessions", "reports"]) {
        await Deno.mkdir(join(this.root, path), {
          recursive: true,
          mode: 0o700,
        });
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (!this.lock) return;
    this.lock.close();
    this.lock = null;
    const path = join(this.root, "lock.json");
    const current = JSON.parse(await Deno.readTextFile(path));
    if (current.token !== this.lockToken) {
      throw new Error("Archive lock ownership changed; preserving lock");
    }
    await Deno.remove(path);
  }

  private async atomic(path: string, bytes: Uint8Array): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    const file = await Deno.open(temporary, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    try {
      let offset = 0;
      while (offset < bytes.length) {
        offset += await file.write(bytes.subarray(offset));
      }
      await file.sync();
    } finally {
      file.close();
    }
    await Deno.rename(temporary, path);
  }

  private async immutable(
    directory: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const id = await digest(bytes);
    const path = join(
      this.root,
      directory,
      id + (directory === "blobs" ? "" : ".json"),
    );
    try {
      const existing = await Deno.readFile(path);
      if (await digest(existing) !== id) {
        throw new Error(`Corrupt immutable ${directory}/${id}`);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      await this.atomic(path, bytes);
    }
    return id;
  }

  async record(
    observation: Omit<Observation, "schema" | "blob" | "bytes">,
    bytes: Uint8Array | null,
  ): Promise<Evidence> {
    if (!this.lock) throw new Error("Archive must be locked before writes");
    const attemptLogs = /\/actions\/runs\/\d+\/attempts\/\d+\/logs$/.test(
      observation.endpoint,
    );
    const zip = attemptLogs && bytes && bytes[0] === 80 && bytes[1] === 75 &&
      (bytes[2] === 3 && bytes[3] === 4 || bytes[2] === 5 && bytes[3] === 6);
    if (bytes && attemptLogs && !zip) {
      bytes = null;
      observation = {
        ...observation,
        status: 0,
        error: "complete attempt log response is not a ZIP archive",
      };
    }
    // Preserve opaque native ZIP bytes. No extraction, decompression or execution occurs.
    if (
      bytes &&
      (zip ? hasSecret(new TextDecoder().decode(bytes)) : sensitive(bytes))
    ) {
      bytes = null;
      observation = {
        ...observation,
        status: 0,
        error: "credential-shaped response refused",
      };
    }
    const blob = bytes ? await this.immutable("blobs", bytes) : null;
    const value: Observation = {
      schema: 1,
      ...observation,
      blob,
      bytes: bytes?.length ?? 0,
    };
    const id = await this.immutable(
      "observations",
      encoder.encode(JSON.stringify(value)),
    );
    return { id, observation: value, body: bytes };
  }

  /** Scan immutable observations so a crash before index publication loses no completed fetch. */
  async evidence(): Promise<Evidence[]> {
    const rows: Evidence[] = [];
    for await (const file of Deno.readDir(join(this.root, "observations"))) {
      if (!file.isFile || !/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const bytes = await Deno.readFile(
        join(this.root, "observations", file.name),
      );
      const id = file.name.slice(0, -5);
      if (await digest(bytes) !== id) {
        throw new Error(`Corrupt observation ${id}`);
      }
      const observation: Observation = JSON.parse(decoder.decode(bytes));
      if (
        observation.schema !== 1 ||
        !Number.isFinite(Date.parse(observation.observedAt))
      ) {
        throw new Error(`Invalid observation ${id}`);
      }
      let body = null;
      if (observation.blob) {
        if (!/^[a-f0-9]{64}$/.test(observation.blob)) {
          throw new Error(`Invalid blob reference ${id}`);
        }
        body = await Deno.readFile(join(this.root, "blobs", observation.blob));
        if (
          await digest(body) !== observation.blob ||
          body.length !== observation.bytes
        ) {
          throw new Error(`Corrupt blob ${observation.blob}`);
        }
      }
      rows.push({ id, observation, body });
    }
    return rows.sort((a, b) =>
      a.observation.observedAt.localeCompare(b.observation.observedAt) ||
      a.id.localeCompare(b.id)
    );
  }

  async saveSession(value: unknown): Promise<void> {
    await this.immutable("sessions", encoder.encode(JSON.stringify(value)));
  }
  async sessions(): Promise<unknown[]> {
    const values = [];
    for await (const file of Deno.readDir(join(this.root, "sessions"))) {
      if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
      const bytes = await Deno.readFile(join(this.root, "sessions", file.name));
      if (await digest(bytes) !== file.name.slice(0, -5)) {
        throw new Error("Corrupt coverage session");
      }
      values.push(JSON.parse(decoder.decode(bytes)));
    }
    return values;
  }
  async saveReport(value: unknown, evidence: Evidence[]): Promise<string> {
    const bytes = encoder.encode(JSON.stringify(value, null, 2) + "\n");
    const id = await this.immutable("reports", bytes);
    await this.atomic(join(this.root, "latest.json"), bytes);
    await this.atomic(
      join(this.root, "index.json"),
      encoder.encode(
        JSON.stringify({
          schema: 1,
          observations: evidence.map((e) => e.id),
          report: id,
        }),
      ),
    );
    return join(this.root, "reports", id + ".json");
  }
}
