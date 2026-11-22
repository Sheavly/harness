/**
 * Test-only: a self-signed certificate for 127.0.0.1 (P-256, valid until 2126) and its key, so a
 * local HTTPS server can show that a model call refuses a certificate it can't verify. The key
 * guards nothing: it was made for this fixture and is trusted by no one.
 */
export const SELF_SIGNED_TLS = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBkDCCATagAwIBAgIURK6wzqA5+/nxsb2cN4TM1HYGOXMwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTEyMzA3MzIzOVoYDzIxMjYxMDMw
MDczMjM5WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAR8vCDpygg063rxkmGCcbQm58c5ntpS5WRmv0n9m1zGr0vv0vWQ+PZ/
Q5coY0XwAV0uhTAJXOo76CcByJXbzRCmo2QwYjAdBgNVHQ4EFgQUBdKC67xsy8KD
SMN4ygGvPBoQ+wYwHwYDVR0jBBgwFoAUBdKC67xsy8KDSMN4ygGvPBoQ+wYwDwYD
VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0gAMEUC
IQCZI7UaZCLju41LACozlNUpXEzjNkmB3ij4YsGVBfl/fAIgSs8re8huwxPeZuRK
dW8/uaj+sPkP54LeC9AfSOOq+fs=
-----END CERTIFICATE-----
`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgGsbPpjXXn5f7HBOk
k0UGKv+K1Nd+9IjNA+dCeFqKLj6hRANCAAR8vCDpygg063rxkmGCcbQm58c5ntpS
5WRmv0n9m1zGr0vv0vWQ+PZ/Q5coY0XwAV0uhTAJXOo76CcByJXbzRCm
-----END PRIVATE KEY-----
`,
} as const;
