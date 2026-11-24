import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFile(new URL(path, root), "utf8");

test("Paseo SDK pins, lockfile and advertised client versions stay aligned", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const lock = JSON.parse(await read("npm-shrinkwrap.json"));
  const version = pkg.dependencies["@getpaseo/client"];
  assert.match(version, /^\d+\.\d+\.\d+$/, "Pin the tested stable SDK version");
  assert.equal(pkg.devDependencies["@getpaseo/plugin"], version);
  for (const name of ["client", "plugin", "protocol", "relay"]) {
    assert.equal(lock.packages[`node_modules/@getpaseo/${name}`].version, version, name);
  }
  for (const path of ["server/daemon.ts", "scripts/verify-pairing.mjs"]) {
    const source = await read(path);
    assert.equal(source.match(/appVersion:\s*"([^"]+)"/)?.[1], version, path);
  }
});

test("Paseo manifest admits the tested SDK release and bounds the next minor", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("paseo-plugin.json"));
  const version = pkg.dependencies["@getpaseo/client"];
  const [major, minor] = version.split(".").map(Number);
  assert.equal(manifest.requirements.paseo, `>=${version} <${major}.${minor + 1}.0`);
});
