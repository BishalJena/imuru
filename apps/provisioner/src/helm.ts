import { spawn } from "node:child_process";

export interface Helm {
  upgradeInstall(
    release: string,
    chart: string,
    ns: string,
    sets: Record<string, string | boolean>,
    timeout: string,
  ): Promise<void>;
  uninstall(release: string, ns: string): Promise<void>;
  /** Release status (deployed, failed, pending-install, ...) or null if it does not exist. */
  status(release: string, ns: string): Promise<string | null>;
  rollback(release: string, ns: string): Promise<void>;
}

/** Runs the helm CLI. Errors carry the tail of helm's stderr as the reason. */
export class HelmCli implements Helm {
  private run(args: string[]): Promise<void> {
    return this.capture(args).then(() => undefined);
  }

  private capture(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn("helm", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      p.stderr.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      p.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) resolve(stdout);
        else
          reject(
            new Error(stderr.trim().split("\n").slice(-3).join(" ") || `helm exited with ${code}`),
          );
      });
    });
  }

  upgradeInstall(
    release: string,
    chart: string,
    ns: string,
    sets: Record<string, string | boolean>,
    timeout: string,
  ) {
    // Strings go through --set-string so values like "0123" stay strings;
    // booleans through --set so templates can test them as booleans.
    const setArgs = Object.entries(sets).flatMap(([k, v]) =>
      typeof v === "boolean" ? ["--set", `${k}=${v}`] : ["--set-string", `${k}=${v}`],
    );
    return this.run([
      "upgrade",
      "--install",
      release,
      chart,
      "-n",
      ns,
      ...setArgs,
      "--wait",
      "--timeout",
      timeout,
    ]);
  }

  async status(release: string, ns: string): Promise<string | null> {
    try {
      const out = JSON.parse(await this.capture(["status", release, "-n", ns, "-o", "json"])) as {
        info?: { status?: string };
      };
      return out.info?.status ?? null;
    } catch (err) {
      if (/not found/i.test((err as Error).message)) return null;
      throw err;
    }
  }

  async rollback(release: string, ns: string) {
    await this.run(["rollback", release, "-n", ns, "--wait"]);
  }

  async uninstall(release: string, ns: string) {
    await this.run(["uninstall", release, "-n", ns, "--ignore-not-found", "--wait"]);
  }
}
