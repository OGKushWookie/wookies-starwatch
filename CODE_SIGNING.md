# Windows code signing

The small private beta currently ships unsigned. GitHub hosting and SHA-256 checksums establish file integrity but do not remove Windows SmartScreen or Smart App Control warnings.

The release workflow deliberately produces an unsigned artifact. Do not add a private certificate or password to the repository. If commercial signing is added later, keep the certificate in the signing provider or repository secret store and sign the already-tested release artifact in a separate protected job.

SignPath is intentionally deferred. Its absence does not affect signed `overlay.js` auto-updates; it affects only Windows publisher reputation and warnings for the launcher EXE.
