use std::borrow::Cow;

use russh::keys::{Algorithm, EcdsaCurve, HashAlg};
use russh::{cipher, compression, kex, mac, Names, Preferred};

const PRODUCT_KEX: &[kex::Name] = &[kex::CURVE25519, kex::ECDH_SHA2_NISTP256, kex::DH_G14_SHA256];

const PRODUCT_KEX_PREFERENCES: &[kex::Name] = &[
    kex::CURVE25519,
    kex::ECDH_SHA2_NISTP256,
    kex::DH_G14_SHA256,
    kex::EXTENSION_SUPPORT_AS_CLIENT,
    kex::EXTENSION_OPENSSH_STRICT_KEX_AS_CLIENT,
];

const PRODUCT_HOST_KEYS: &[Algorithm] = &[
    Algorithm::Ed25519,
    Algorithm::Ecdsa {
        curve: EcdsaCurve::NistP256,
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha512),
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha256),
    },
];

const PRODUCT_CIPHERS: &[cipher::Name] = &[
    cipher::CHACHA20_POLY1305,
    cipher::AES_256_GCM,
    cipher::AES_128_GCM,
    cipher::AES_256_CTR,
    cipher::AES_128_CTR,
];

const PRODUCT_MACS: &[mac::Name] = &[
    mac::HMAC_SHA512_ETM,
    mac::HMAC_SHA256_ETM,
    mac::HMAC_SHA512,
    mac::HMAC_SHA256,
];

const PRODUCT_COMPRESSION: &[compression::Name] = &[compression::NONE];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshAlgorithmPolicy {
    pub kex: Vec<String>,
    pub host_key: Vec<String>,
    pub cipher: Vec<String>,
    pub mac: Vec<String>,
    pub compression: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SshNegotiatedAlgorithms {
    pub kex: String,
    pub host_key: String,
    pub cipher: String,
    pub client_to_server_mac: String,
    pub server_to_client_mac: String,
}

impl SshAlgorithmPolicy {
    pub fn allows(&self, negotiated: &SshNegotiatedAlgorithms) -> bool {
        self.kex.contains(&negotiated.kex)
            && self.host_key.contains(&negotiated.host_key)
            && self.cipher.contains(&negotiated.cipher)
            && self.mac.contains(&negotiated.client_to_server_mac)
            && self.mac.contains(&negotiated.server_to_client_mac)
    }
}

impl SshNegotiatedAlgorithms {
    pub(crate) fn from_names(names: &Names) -> Self {
        Self {
            kex: names.kex.as_ref().to_owned(),
            host_key: names.key.to_string(),
            cipher: names.cipher.as_ref().to_owned(),
            client_to_server_mac: names.client_mac.as_ref().to_owned(),
            server_to_client_mac: names.server_mac.as_ref().to_owned(),
        }
    }
}

pub fn product_algorithm_policy() -> SshAlgorithmPolicy {
    let preferred = preferred_algorithms();
    SshAlgorithmPolicy {
        kex: PRODUCT_KEX
            .iter()
            .map(|algorithm| algorithm.as_ref().to_owned())
            .collect(),
        host_key: preferred.key.iter().map(ToString::to_string).collect(),
        cipher: preferred
            .cipher
            .iter()
            .map(|algorithm| algorithm.as_ref().to_owned())
            .collect(),
        mac: preferred
            .mac
            .iter()
            .map(|algorithm| algorithm.as_ref().to_owned())
            .collect(),
        compression: preferred
            .compression
            .iter()
            .map(|algorithm| algorithm.as_ref().to_owned())
            .collect(),
    }
}

pub(crate) fn preferred_algorithms() -> Preferred {
    Preferred {
        kex: Cow::Borrowed(PRODUCT_KEX_PREFERENCES),
        key: Cow::Borrowed(PRODUCT_HOST_KEYS),
        cipher: Cow::Borrowed(PRODUCT_CIPHERS),
        mac: Cow::Borrowed(PRODUCT_MACS),
        compression: Cow::Borrowed(PRODUCT_COMPRESSION),
    }
}

#[cfg(test)]
mod tests {
    use super::{preferred_algorithms, product_algorithm_policy};

    #[test]
    fn fixes_the_product_algorithm_order() {
        let policy = product_algorithm_policy();

        assert_eq!(
            policy.kex,
            [
                "curve25519-sha256",
                "ecdh-sha2-nistp256",
                "diffie-hellman-group14-sha256",
            ]
        );
        assert_eq!(
            policy.host_key,
            [
                "ssh-ed25519",
                "ecdsa-sha2-nistp256",
                "rsa-sha2-512",
                "rsa-sha2-256",
            ]
        );
        assert_eq!(
            policy.cipher,
            [
                "chacha20-poly1305@openssh.com",
                "aes256-gcm@openssh.com",
                "aes128-gcm@openssh.com",
                "aes256-ctr",
                "aes128-ctr",
            ]
        );
        assert_eq!(
            policy.mac,
            [
                "hmac-sha2-512-etm@openssh.com",
                "hmac-sha2-256-etm@openssh.com",
                "hmac-sha2-512",
                "hmac-sha2-256",
            ]
        );
        assert_eq!(policy.compression, ["none"]);

        let preferred = preferred_algorithms();
        let kex_preferences = preferred.kex.iter().map(AsRef::as_ref).collect::<Vec<_>>();
        assert_eq!(
            kex_preferences,
            [
                "curve25519-sha256",
                "ecdh-sha2-nistp256",
                "diffie-hellman-group14-sha256",
                "ext-info-c",
                "kex-strict-c-v00@openssh.com",
            ]
        );
    }

    #[test]
    fn excludes_legacy_and_unencrypted_algorithms() {
        let policy = product_algorithm_policy();

        for algorithm in [
            "diffie-hellman-group1-sha1",
            "diffie-hellman-group14-sha1",
            "diffie-hellman-group-exchange-sha1",
            "none",
        ] {
            assert!(!policy.kex.iter().any(|allowed| allowed == algorithm));
        }
        for algorithm in ["ssh-dss", "ssh-rsa"] {
            assert!(!policy.host_key.iter().any(|allowed| allowed == algorithm));
        }
        for algorithm in [
            "3des-cbc",
            "aes128-cbc",
            "aes192-cbc",
            "aes256-cbc",
            "clear",
            "none",
        ] {
            assert!(!policy.cipher.iter().any(|allowed| allowed == algorithm));
        }
        for algorithm in ["hmac-sha1", "hmac-sha1-etm@openssh.com", "none"] {
            assert!(!policy.mac.iter().any(|allowed| allowed == algorithm));
        }
    }
}
