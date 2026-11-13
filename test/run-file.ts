import { execFile, type ExecFileOptions } from "node:child_process";

/**
 * Runs a program and resolves with its output, or rejects with an error that carries the output
 * and exit code, as `promisify(execFile)` does. Written out because a runner that wraps
 * child_process can drop `execFile`'s `util.promisify.custom` (hushrun 0.14's Vitest plugin
 * does), and `promisify(execFile)` then resolves to stdout alone.
 */
export function runFile(file: string, args: string[], opts: ExecFileOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stdout: String(stdout), stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
