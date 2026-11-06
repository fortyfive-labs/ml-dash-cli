import { randomUUID } from 'node:crypto';

export interface FileMultipart { body: Blob; contentType: string }

/** Keep filenames literal: FormData percent-escapes quotes, which multipart receivers retain. */
export function fileMultipart(fields: Record<string, string>, file: Blob, filename: string): FileMultipart {
  const boundary = `mldash-${randomUUID()}`;
  const parts: Array<string | Blob> = [];
  for (const [name, value] of Object.entries(fields))
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file"; filename*=UTF-8''${encoded}\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`,
    file, `\r\n--${boundary}--\r\n`);
  return { body: new Blob(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
