// Once per test run, before any test: a blank and a migrated PGlite saved as tarballs, so each
// test loads a copy (a fifth of a second) instead of running initdb (most of a second, and
// several seconds when every test file starts one at once). Not used with TEST_DATABASE_URL.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { pgliteDb } from "../src/db.js";
import { migrate } from "../src/migrate.js";

declare module "vitest" {
  export interface ProvidedContext {
    pgliteTemplates: { blank: string; migrated: string } | null;
  }
}

export default async function setup(project: TestProject) {
  if (process.env["TEST_DATABASE_URL"]) {
    project.provide("pgliteTemplates", null);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "sbr-pglite-"));
  const db = await pgliteDb();
  const save = async (name: string) => {
    const path = join(dir, `${name}.tar`);
    await writeFile(path, Buffer.from(await (await db.dump()).arrayBuffer()));
    return path;
  };
  const blank = await save("blank");
  await migrate(db);
  const migrated = await save("migrated");
  await db.close();
  project.provide("pgliteTemplates", { blank, migrated });
  return () => rm(dir, { recursive: true, force: true });
}
