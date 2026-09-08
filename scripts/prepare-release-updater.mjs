import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SOURCE_CONFIG = "apps/desktop/src-tauri/tauri.conf.json";

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument?.startsWith("--") || !value) {
      throw new Error(
        `Unknown or incomplete argument: ${argument ?? "<missing>"}`,
      );
    }
    values[argument.slice(2)] = value;
  }
  for (const required of ["version", "output"]) {
    if (!values[required])
      throw new Error(`Missing required argument --${required}`);
  }
  if (!/^v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(values.version)) {
    throw new Error(`Unsupported release version: ${values.version}`);
  }
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const source = JSON.parse(
    await readFile(new URL(`../${SOURCE_CONFIG}`, import.meta.url), "utf8"),
  );
  const version = options.version.replace(/^v/, "");
  const publicKey = source.plugins?.updater?.pubkey;
  const endpoints = source.plugins?.updater?.endpoints;
  if (typeof publicKey !== "string" || publicKey.length === 0) {
    throw new Error(
      "Production Tauri config must contain an updater public key",
    );
  }
  if (
    !Array.isArray(endpoints) ||
    endpoints.some((endpoint) => !/^https:\/\//.test(endpoint))
  ) {
    throw new Error(
      "Production Tauri config must contain HTTPS updater endpoints",
    );
  }

  const config = {
    version,
    bundle: {
      createUpdaterArtifacts: true,
    },
    plugins: {
      updater: {
        pubkey: publicKey,
        endpoints,
        windows: {
          installMode: "passive",
        },
      },
    },
  };
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Release updater configuration written to ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(
      `::error title=Release updater configuration failed::${message}`,
    );
  }
  process.exitCode = 1;
});
