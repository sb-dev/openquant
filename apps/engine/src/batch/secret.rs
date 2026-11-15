//! A value that must never reach a log, a trace or an error text.

use std::fmt;

/// A credential or a capability. It prints as `<redacted>` with `Debug` and `Display`, has no
/// serialisation and gives its text only to the code that signs a request ([`Secret::expose`]).
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    /// Wrap a secret text.
    #[must_use]
    pub fn new(text: impl Into<String>) -> Self {
        Self(text.into())
    }

    /// The text, for the one place that writes it into a request header.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_never_prints() {
        let secret = Secret::new("synthetic-token-value");
        for text in [
            format!("{secret:?}"),
            format!("{secret}"),
            format!("{secret:#?}"),
        ] {
            assert!(!text.contains("synthetic"), "{text}");
        }
        assert_eq!(secret.expose(), "synthetic-token-value");
    }
}
