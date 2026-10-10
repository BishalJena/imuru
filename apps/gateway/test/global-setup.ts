import { execFileSync } from "node:child_process";
import pg from "pg";

// Runs the suite against a real Postgres: TEST_DATABASE_URL if set, otherwise
// a throwaway container on a random port.
export default async function setup({
  provide,
}: {
  provide: (key: string, value: string) => void;
}) {
  let url = process.env.TEST_DATABASE_URL;
  let container: string | undefined;
  if (!url) {
    container = execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "-e",
        "POSTGRES_PASSWORD=test",
        "-p",
        "127.0.0.1::5432",
        "postgres:17.11-alpine",
      ],
      { encoding: "utf8" },
    ).trim();
    const port = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" })
      .trim()
      .split(":")
      .pop();
    url = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
  }
  for (let i = 0; ; i++) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      break;
    } catch (err) {
      await client.end().catch(() => undefined);
      if (i > 60) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  provide("databaseUrl", url);
  return () => {
    if (container) execFileSync("docker", ["rm", "-f", container]);
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}
