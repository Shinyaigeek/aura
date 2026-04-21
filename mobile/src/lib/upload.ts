import * as FileSystem from "expo-file-system";

import type { ServerConfig } from "./storage";

export type UploadResult = {
  path: string;
  size: number;
};

export type UploadProgress = {
  sent: number;
  total: number;
};

export type UploadOptions = {
  filename?: string;
  /** Absolute directory on the server. If absent, server writes into the
   * session's tmux pane cwd. */
  dest?: string;
  mimeType?: string;
  onProgress?: (p: UploadProgress) => void;
};

// uploadFile pushes a local file on the phone to the server's filesystem via
// POST /sessions/{id}/upload. Returns the server-side absolute path of the
// saved file.
export async function uploadFile(
  cfg: ServerConfig,
  sessionId: string,
  localUri: string,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  const base = cfg.url.replace(/\/+$/, "").replace(/^ws(s?):\/\//, "http$1://");
  const url = `${base}/sessions/${encodeURIComponent(sessionId || "default")}/upload`;

  // Server reads text fields (dest, filename) before the file part in a single
  // streaming pass. Multipart key order in the request body mirrors the key
  // order we hand to FileSystem — declaring dest/filename here guarantees they
  // land first.
  const parameters: Record<string, string> = {};
  if (opts.dest) parameters.dest = opts.dest;
  if (opts.filename) parameters.filename = opts.filename;

  const task = FileSystem.createUploadTask(
    url,
    localUri,
    {
      httpMethod: "POST",
      uploadType: FileSystem.FileSystemUploadType.MULTIPART,
      fieldName: "file",
      parameters,
      mimeType: opts.mimeType,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
      },
    },
    (data) => {
      opts.onProgress?.({
        sent: data.totalBytesSent,
        total: data.totalBytesExpectedToSend,
      });
    },
  );

  const res = await task.uploadAsync();
  if (!res) throw new Error("upload cancelled");
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`upload failed (${res.status}): ${res.body || "no body"}`);
  }

  try {
    const parsed = JSON.parse(res.body) as UploadResult;
    if (typeof parsed.path !== "string") throw new Error("missing path");
    return parsed;
  } catch (e) {
    throw new Error(`upload: invalid response body: ${e instanceof Error ? e.message : String(e)}`);
  }
}
