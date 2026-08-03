import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

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

  for (const required of ["public-key", "output", "version"]) {
    if (!values[required])
      throw new Error(`Missing required argument --${required}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(values.version)) {
    throw new Error(
      "Updater test version must be a three-part numeric version",
    );
  }
  return values;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const publicKey = (await readFile(options["public-key"], "utf8")).trim();
  const decodedKey = Buffer.from(publicKey, "base64").toString("utf8");
  if (!decodedKey.includes("minisign public key")) {
    throw new Error("Updater public key is not a Tauri Minisign public key");
  }

  const config = {
    version: options.version,
    bundle: {
      createUpdaterArtifacts: true,
    },
    plugins: {
      updater: {
        pubkey: publicKey,
      },
    },
  };
  const outputPath = path.resolve(options.output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Updater test configuration written to ${outputPath}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.GITHUB_ACTIONS === "true") {
    console.error(`::error title=Updater configuration failed::${message}`);
  }
  process.exitCode = 1;
});
