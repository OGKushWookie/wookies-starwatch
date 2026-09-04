# Security

Report a suspected credential leak, update-signature problem, or cloud-account authorization issue privately to the maintainer. Do not include an official API key, Steam sign-in data, recovery code, device credential, or raw profile data in a public issue.

The launcher accepts overlay updates only from the pinned HTTPS host after verifying both the RSA signature on the manifest and the SHA-256 hash of the downloaded script. Official API keys are protected with Windows DPAPI for the current Windows user. The companion service never receives an official API key.

This project does not automate gameplay or send gameplay actions to the Stellar Odyssey server.
