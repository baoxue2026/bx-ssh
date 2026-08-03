use std::{
    collections::BTreeMap,
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::Url;

type DynError = Box<dyn Error + Send + Sync>;

#[derive(Debug)]
struct Options {
    bundle_dir: PathBuf,
    public_key: PathBuf,
    wrong_public_key: PathBuf,
    output_dir: PathBuf,
    platform: String,
    arch: String,
    version: String,
    base_url: Url,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ValidationReport {
    schema_version: u8,
    platform: String,
    architecture: String,
    version: String,
    passed: bool,
    artifacts: Vec<ArtifactValidation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactValidation {
    path: String,
    size_bytes: u64,
    sha256: String,
    target: String,
    signature_valid: bool,
    tamper_rejected: bool,
    wrong_key_rejected: bool,
}

#[derive(Debug, Serialize)]
struct UpdateManifest {
    version: String,
    notes: String,
    platforms: BTreeMap<String, ManifestPlatform>,
}

#[derive(Debug, Serialize)]
struct ManifestPlatform {
    signature: String,
    url: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        if env::var_os("GITHUB_ACTIONS").is_some() {
            eprintln!(
                "::error title=Updater signature validation failed::{}",
                escape_workflow_command(&error.to_string())
            );
        }
        std::process::exit(1);
    }
}

fn run() -> Result<(), DynError> {
    let options = parse_options()?;
    let public_key = read_public_key(&options.public_key)?;
    let wrong_public_key = read_public_key(&options.wrong_public_key)?;
    let mut signatures = find_signature_files(&options.bundle_dir)?;
    signatures.sort();
    if signatures.is_empty() {
        return Err("no updater signature files were generated".into());
    }

    let mut artifacts = Vec::with_capacity(signatures.len());
    let mut platforms = BTreeMap::new();
    for signature_path in signatures {
        let artifact_path = signature_path.with_extension("");
        if !artifact_path.is_file() {
            return Err(format!(
                "signature has no matching updater artifact: {}",
                signature_path.display()
            )
            .into());
        }

        let bytes = fs::read(&artifact_path)?;
        if bytes.is_empty() {
            return Err(format!("updater artifact is empty: {}", artifact_path.display()).into());
        }
        let signature_text = fs::read_to_string(&signature_path)?;
        verify(&bytes, &signature_text, &public_key)?;

        let mut tampered = bytes.clone();
        let middle = tampered.len() / 2;
        tampered[middle] ^= 1;
        let tamper_rejected = verify(&tampered, &signature_text, &public_key).is_err();
        let wrong_key_rejected = verify(&bytes, &signature_text, &wrong_public_key).is_err();
        if !tamper_rejected || !wrong_key_rejected {
            return Err(format!(
                "negative signature validation unexpectedly passed: {}",
                artifact_path.display()
            )
            .into());
        }

        let target = updater_target(&artifact_path, &options.platform, &options.arch)?;
        let file_name = artifact_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("updater artifact filename is not valid UTF-8")?;
        let url = options.base_url.join(file_name)?.to_string();
        if platforms
            .insert(
                target.clone(),
                ManifestPlatform {
                    signature: signature_text.trim().to_owned(),
                    url,
                },
            )
            .is_some()
        {
            return Err(format!("multiple updater artifacts map to target {target}").into());
        }

        let relative_path = artifact_path
            .strip_prefix(&options.bundle_dir)?
            .to_string_lossy()
            .replace('\\', "/");
        artifacts.push(ArtifactValidation {
            path: relative_path,
            size_bytes: bytes.len() as u64,
            sha256: hex_sha256(&bytes),
            target,
            signature_valid: true,
            tamper_rejected,
            wrong_key_rejected,
        });
    }

    let report = ValidationReport {
        schema_version: 1,
        platform: options.platform.clone(),
        architecture: options.arch,
        version: options.version.clone(),
        passed: true,
        artifacts,
    };
    let manifest = UpdateManifest {
        version: options.version,
        notes: "BX SSH G0-07 signed full-package update validation".to_owned(),
        platforms,
    };

    fs::create_dir_all(&options.output_dir)?;
    fs::write(
        options
            .output_dir
            .join(format!("update-validation-{}.json", options.platform)),
        format!("{}\n", serde_json::to_string_pretty(&report)?),
    )?;
    fs::write(
        options
            .output_dir
            .join(format!("latest-{}.json", options.platform)),
        format!("{}\n", serde_json::to_string_pretty(&manifest)?),
    )?;
    fs::write(
        options
            .output_dir
            .join(format!("update-validation-{}.md", options.platform)),
        markdown_report(&report),
    )?;

    for artifact in &report.artifacts {
        println!(
            "{}: signature PASS, tamper PASS, wrong-key PASS",
            artifact.path
        );
    }
    Ok(())
}

fn parse_options() -> Result<Options, DynError> {
    let mut args = env::args().skip(1);
    let mut values = BTreeMap::new();
    while let Some(argument) = args.next() {
        if !argument.starts_with("--") {
            return Err(format!("unexpected argument: {argument}").into());
        }
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {argument}"))?;
        values.insert(argument, value);
    }

    let required = |name: &str| -> Result<String, DynError> {
        values
            .get(name)
            .cloned()
            .ok_or_else(|| format!("missing required argument {name}").into())
    };
    let platform = required("--platform")?.to_lowercase();
    if !matches!(platform.as_str(), "windows" | "macos" | "linux") {
        return Err(format!("unsupported platform: {platform}").into());
    }
    let mut base_url = Url::parse(&required("--base-url")?)?;
    if base_url.scheme() != "https" {
        return Err("updater artifact base URL must use HTTPS".into());
    }
    if !base_url.path().ends_with('/') {
        base_url.set_path(&format!("{}/", base_url.path()));
    }

    Ok(Options {
        bundle_dir: PathBuf::from(required("--bundle-dir")?),
        public_key: PathBuf::from(required("--public-key")?),
        wrong_public_key: PathBuf::from(required("--wrong-public-key")?),
        output_dir: PathBuf::from(required("--output-dir")?),
        platform,
        arch: required("--arch")?,
        version: required("--version")?,
        base_url,
    })
}

fn read_public_key(path: &Path) -> Result<PublicKey, DynError> {
    let encoded = fs::read_to_string(path)?;
    let decoded = STANDARD.decode(encoded.trim())?;
    let text = std::str::from_utf8(&decoded)?;
    Ok(PublicKey::decode(text)?)
}

fn verify(data: &[u8], signature_text: &str, public_key: &PublicKey) -> Result<(), DynError> {
    let decoded = STANDARD.decode(signature_text.trim())?;
    let text = std::str::from_utf8(&decoded)?;
    let signature = Signature::decode(text)?;
    public_key.verify(data, &signature, true)?;
    Ok(())
}

fn find_signature_files(directory: &Path) -> Result<Vec<PathBuf>, DynError> {
    let mut signatures = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            signatures.extend(find_signature_files(&path)?);
        } else if path.extension().is_some_and(|extension| extension == "sig") {
            signatures.push(path);
        }
    }
    Ok(signatures)
}

fn updater_target(path: &Path, platform: &str, arch: &str) -> Result<String, DynError> {
    let lower = path.to_string_lossy().to_lowercase();
    let os = if platform == "macos" {
        "darwin"
    } else {
        platform
    };
    let installer = if lower.contains("nsis") {
        Some("nsis")
    } else if lower.contains("msi") {
        Some("msi")
    } else if lower.contains("appimage") {
        Some("appimage")
    } else if lower.contains(".deb") {
        Some("deb")
    } else if lower.contains(".rpm") {
        Some("rpm")
    } else if platform == "macos" {
        None
    } else {
        return Err(format!("cannot determine updater bundle type: {}", path.display()).into());
    };

    Ok(match installer {
        Some(installer) => format!("{os}-{arch}-{installer}"),
        None => format!("{os}-{arch}"),
    })
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn markdown_report(report: &ValidationReport) -> String {
    let rows = report
        .artifacts
        .iter()
        .map(|artifact| {
            format!(
                "| `{}` | {} | {} | PASS | PASS | PASS |",
                artifact.path, artifact.target, artifact.size_bytes
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "# BX SSH updater signature validation\n\n- Platform: {}\n- Architecture: {}\n- Version: {}\n- Result: PASS\n\n| Artifact | Target | Bytes | Signature | Tamper rejected | Wrong key rejected |\n| --- | --- | ---: | --- | --- | --- |\n{}\n",
        report.platform, report.architecture, report.version, rows
    )
}

fn escape_workflow_command(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::updater_target;

    #[test]
    fn maps_bundle_paths_to_static_manifest_targets() {
        assert_eq!(
            updater_target(
                Path::new("bundle/msi/BX SSH_0.1.1_x64_en-US.msi"),
                "windows",
                "x86_64"
            )
            .unwrap(),
            "windows-x86_64-msi"
        );
        assert_eq!(
            updater_target(
                Path::new("bundle/nsis/BX SSH_0.1.1_x64-setup.exe"),
                "windows",
                "x86_64"
            )
            .unwrap(),
            "windows-x86_64-nsis"
        );
        assert_eq!(
            updater_target(
                Path::new("bundle/macos/BX SSH.app.tar.gz"),
                "macos",
                "aarch64"
            )
            .unwrap(),
            "darwin-aarch64"
        );
        assert_eq!(
            updater_target(
                Path::new("bundle/appimage/BX SSH_0.1.1_amd64.AppImage.tar.gz"),
                "linux",
                "x86_64"
            )
            .unwrap(),
            "linux-x86_64-appimage"
        );
        assert_eq!(
            updater_target(
                Path::new("bundle/deb/BX SSH_0.1.1_amd64.deb"),
                "linux",
                "x86_64"
            )
            .unwrap(),
            "linux-x86_64-deb"
        );
        assert_eq!(
            updater_target(
                Path::new("bundle/rpm/BX SSH-0.1.1-1.x86_64.rpm"),
                "linux",
                "x86_64"
            )
            .unwrap(),
            "linux-x86_64-rpm"
        );
    }

    #[test]
    fn rejects_unknown_updater_bundle_types() {
        assert!(updater_target(
            Path::new("bundle/unknown/BX SSH_0.1.1.bin"),
            "linux",
            "x86_64"
        )
        .is_err());
    }
}
