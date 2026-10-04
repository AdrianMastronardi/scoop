# Upstream TLS fixtures

These certificates and the shared private key are test-only material. The CA signing key was discarded. Never install this CA in the production trust store.

`Scoop.tls.test.js` starts a child test process with this CA in `NODE_EXTRA_CA_CERTS`. That child exercises real HTTPS servers, the pinned Portal proxy, sandboxed Chromium, the CLI and archive reconstruction; the parent process's trust configuration is unchanged.

The trusted leaf certificates were signed with OpenSSL's `ca` command using these validity windows and SANs:

| Certificate | Validity (UTC) | Subject alternative names |
| --- | --- | --- |
| valid | 2000-01-01 to 2125-01-01 | localhost, 127.0.0.1, ::1 |
| expired | 2000-01-01 to 2001-01-01 | localhost, 127.0.0.1 |
| future | 2100-01-01 to 2125-01-01 | localhost, 127.0.0.1 |
| wrong | 2000-01-01 to 2125-01-01 | other.test, 192.0.2.1 |

`untrusted.pem` is a self-signed localhost/127.0.0.1 certificate, outside the fixture CA. The CA and self-signed certificate have a 100-year validity window from generation in October 2026. Fixtures should be regenerated before those boundaries become relevant.
