/**
 * Putting the verified bytes where the old binary was.
 *
 * The rule throughout: a failure at any point leaves the currently installed
 * binary exactly as it was, and leaves no temporary file behind. The staged
 * file is therefore created inside the install directory — so the final step
 * is a rename within one filesystem rather than a copy across two — and the
 * caller unlinks it on every error path.
 */
import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, chmod, lstat, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export class ReplaceError extends Error {}

/** The install receipt install.sh and install.ps1 write, in their format. */
export const RECEIPT_NAME = ".ml-dash.receipt";

export const receiptContents = (version: string, platform: string, sha256: string, source: string): string =>
  `channel=r2\nversion=${version}\nplatform=${platform}\nsha256=${sha256}\nsource=${source}\n`;

/**
 * Directories that belong to another package manager.
 *
 * This is the check that actually protects a symlinked install, and it exists
 * because the obvious one does not: `process.execPath` is already
 * symlink-resolved by the OS (verified on this host — invoking a compiled
 * binary through a symlink reports the link's *target*). So when
 * `~/.local/bin/ml-dash` points into a Homebrew cellar or a pipx venv, the
 * path this command is handed is the store's real file, and the lstat check
 * below never sees a link at all. Recognising the store by its path is what is
 * left, and it is the case worth catching: replacing a file another tool
 * believes it owns leaves that tool's metadata describing bytes that are no
 * longer there.
 */
const MANAGED_STORES: { pattern: RegExp; manager: string; fix: string }[] = [
  { pattern: /(^|\/)\.?nix\/store\//, manager: "Nix", fix: "nix profile upgrade" },
  { pattern: /(^|\/)(Cellar|linuxbrew|homebrew)\//, manager: "Homebrew", fix: "brew upgrade ml-dash" },
  { pattern: /(^|\/)site-packages\//, manager: "pip", fix: "pip install --upgrade ml-dash" },
  { pattern: /(^|\/)(pipx|\.venv|venv)\//, manager: "pipx or a virtualenv", fix: "pipx upgrade ml-dash" },
  { pattern: /(^|\/)node_modules\//, manager: "npm", fix: "npm install -g @dreamlake/ml-dash@latest" },
  { pattern: /(^|\/)\.cargo\/(registry|bin)\//, manager: "cargo", fix: "cargo install --force ml-dash" },
];

/**
 * Refuse anything that is not a plain, writable, regular file we can swap, and
 * anything that belongs to a package manager other than this one.
 */
export async function checkReplaceable(target: string): Promise<void> {
  const store = MANAGED_STORES.find((s) => s.pattern.test(target));
  if (store) {
    throw new ReplaceError(
      `${target} is inside a directory ${store.manager} manages, so it is not this command's to replace.\n` +
        `  Replacing it would leave ${store.manager} describing bytes that are no longer there.\n` +
        `  Update it with:  ${store.fix}`,
    );
  }

  let info;
  try {
    info = await lstat(target);
  } catch (e) {
    throw new ReplaceError(`cannot inspect ${target}: ${(e as Error).message}`);
  }
  if (info.isSymbolicLink()) {
    throw new ReplaceError(
      `${target} is a symlink, so it is managed by something else (a package manager, or a shim).\n` +
        `  Update it with whatever installed it, or install a standalone copy with install.sh.`,
    );
  }
  if (!info.isFile()) {
    throw new ReplaceError(`${target} is not a regular file`);
  }
  const dir = path.dirname(target);
  try {
    await access(dir, constants.W_OK);
  } catch {
    throw new ReplaceError(
      `cannot write to ${dir}.\n` +
        `  ml-dash update replaces the binary in place, so that directory has to be writable.\n` +
        `  Re-run with the permissions that own it, or reinstall into a directory you own:\n` +
        `      curl -fsSL https://pub-42e1dcc7de574d4a92984865fdc95f10.r2.dev/install.sh | sh -s -- --install-dir ~/.local/bin`,
    );
  }
}

/** The mode of the binary being replaced, so an update does not widen or narrow it. */
export async function currentMode(target: string): Promise<number> {
  try {
    return (await stat(target)).mode & 0o777;
  } catch {
    return 0o755;
  }
}

export interface Swap {
  target: string;
  staged: string;
  version: string;
  platform: string;
  sha256: string;
  source: string;
}

/**
 * POSIX: rename(2) over the running binary.
 *
 * Replacing a running executable is fine here — the kernel keeps the old inode
 * alive for the current process and the directory entry flips atomically — so
 * the update takes effect for the next invocation with no helper and no window
 * in which `ml-dash` is missing from PATH.
 */
export async function swapInPlace(swap: Swap): Promise<void> {
  await chmod(swap.staged, await currentMode(swap.target));
  await rename(swap.staged, swap.target);
  await writeReceiptIfOwned(swap);
}

/**
 * Only where the installer already left one. Writing a receipt that was never
 * there would be this command claiming an install it did not make; not
 * refreshing one that is there would leave install.sh convinced the binary had
 * been tampered with, and refusing to run without --force.
 */
async function writeReceiptIfOwned(swap: Swap): Promise<void> {
  const receipt = path.join(path.dirname(swap.target), RECEIPT_NAME);
  if (!existsSync(receipt)) return;
  try {
    await writeFile(receipt, receiptContents(swap.version, swap.platform, swap.sha256, swap.source));
  } catch {
    // The binary is already updated and correct; a stale receipt only costs a
    // --force on some future install.sh run.
  }
}

/** Single-quote a string for PowerShell, where '' is the escape for '. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * The PowerShell that finishes a Windows update after this process is gone.
 *
 * Windows holds an open image section on a running .exe, so the rename in
 * swapInPlace fails with a sharing violation rather than succeeding. The
 * smallest correct answer is to wait for this exact PID to exit and then do
 * the same move — no service, no scheduled task, nothing left installed. The
 * script deletes the staged file if the move fails and deletes itself last, so
 * neither it nor the download survives a failure.
 */
export function windowsHelperScript(swap: Swap, pid: number): string {
  const receipt = path.join(path.dirname(swap.target), RECEIPT_NAME);
  return [
    "$ErrorActionPreference = 'Stop'",
    // An already-exited PID makes Wait-Process throw; that is the success case.
    `try { Wait-Process -Id ${pid} -Timeout 300 } catch { }`,
    "try {",
    `  Move-Item -LiteralPath ${psQuote(swap.staged)} -Destination ${psQuote(swap.target)} -Force`,
    `  if (Test-Path -LiteralPath ${psQuote(receipt)}) {`,
    `    @(${[
      `'channel=r2'`,
      psQuote(`version=${swap.version}`),
      psQuote(`platform=${swap.platform}`),
      psQuote(`sha256=${swap.sha256}`),
      psQuote(`source=${swap.source}`),
    ].join(", ")}) | Set-Content -LiteralPath ${psQuote(receipt)} -Encoding ASCII`,
    "  }",
    "} catch {",
    `  Remove-Item -LiteralPath ${psQuote(swap.staged)} -Force -ErrorAction SilentlyContinue`,
    "} finally {",
    "  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue",
    "}",
    "",
  ].join("\n");
}

export const windowsHelperArgs = (helperPath: string): string[] => [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  helperPath,
];

/**
 * Write the helper and hand it off. Detached and unref'd so `ml-dash update`
 * can exit normally — which is the thing the helper is waiting for.
 */
export async function scheduleWindowsSwap(swap: Swap, pid: number = process.pid): Promise<void> {
  const helper = path.join(path.dirname(swap.target), `.ml-dash.update.${pid}.ps1`);
  await writeFile(helper, windowsHelperScript(swap, pid), "utf8");
  try {
    const child = spawn("powershell.exe", windowsHelperArgs(helper), {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    await rm(helper, { force: true });
    throw new ReplaceError(`cannot start the updater: ${(e as Error).message}`);
  }
}
