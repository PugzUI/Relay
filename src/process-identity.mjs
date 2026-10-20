import { readFile } from "node:fs/promises";

/** Return the Linux process start identity, false if absent, or null if unknown. */
export async function readLinuxProcessStart(pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return null;
  let stat;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? false : null;
  }
  try {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const close = stat.lastIndexOf(")");
    const fields =
      close < 0
        ? []
        : stat
            .slice(close + 2)
            .trim()
            .split(/\s+/);
    return boot && fields.length >= 20 && /^\d+$/.test(fields[19]) ? `${boot}:${fields[19]}` : null;
  } catch {
    return null;
  }
}
