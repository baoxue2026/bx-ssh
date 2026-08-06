use url::Url;

use crate::command_error::{CommandError, CommandErrorCode};

const MAX_EXTERNAL_URL_LENGTH: usize = 2_048;

#[tauri::command]
#[specta::specta]
pub(crate) fn open_external_url(url: String) -> Result<(), CommandError> {
    let url = validate_external_url(&url)?;
    open::that_detached(url.as_str()).map_err(|_| {
        CommandError::new(
            CommandErrorCode::ExternalLinkOpenFailed,
            "unable to open the external link",
        )
    })
}

fn validate_external_url(value: &str) -> Result<Url, CommandError> {
    let invalid = || {
        CommandError::new(
            CommandErrorCode::InvalidExternalUrl,
            "external links must be credential-free HTTP or HTTPS URLs",
        )
    };

    if value.is_empty() || value.len() > MAX_EXTERNAL_URL_LENGTH {
        return Err(invalid());
    }

    let url = Url::parse(value).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::validate_external_url;
    use crate::command_error::CommandErrorCode;

    #[test]
    fn accepts_credential_free_http_urls() {
        let url = validate_external_url("https://docs.example.com:8443/a path?q=1").unwrap();

        assert_eq!(url.host_str(), Some("docs.example.com"));
        assert_eq!(url.port(), Some(8443));
        assert_eq!(url.as_str(), "https://docs.example.com:8443/a%20path?q=1");
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_urls() {
        for value in [
            "javascript:alert(1)",
            "file:///tmp/secret",
            "https://user:secret@example.com/",
            "not a URL",
            "",
        ] {
            let error = validate_external_url(value).unwrap_err();
            assert_eq!(error.code, CommandErrorCode::InvalidExternalUrl);
        }
    }
}
