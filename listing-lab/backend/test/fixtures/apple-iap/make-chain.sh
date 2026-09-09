#!/bin/sh
# Builds the TEST certificate chain used by test/iap.test.js.
#
# Apple signs every App Store transaction (the JWS the iOS app sends to
# POST /api/iap/verify) with a leaf certificate that chains through the
# Worldwide Developer Relations intermediate to "Apple Root CA - G3". The
# tests cannot use Apple's real chain — nobody outside Apple holds the leaf's
# private key — so this script makes a look-alike chain of three EC
# certificates with the same shape, the same signature algorithms and the
# same Apple-specific extension OIDs the verifier checks:
#
#   root         P-384, self-signed, ecdsa-with-SHA384
#   intermediate P-256, signed by root, carries OID 1.2.840.113635.100.6.2.1
#                (what marks Apple's WWDR intermediate)
#   leaf         P-256, signed by intermediate, carries OID
#                1.2.840.113635.100.6.11.1 (what marks the App Store
#                receipt/transaction signing certificate)
#
# The tests hand the ROOT below to the verifier as the trust anchor in place
# of Apple's, and sign transaction payloads with leaf.key. Nothing here is a
# secret: it is a throwaway key pair that trusts nothing in production.
#
# Re-run to regenerate (OpenSSL 3.x). Validity is 100 years so the fixtures
# do not expire under the tests.
set -e
cd "$(dirname "$0")"
DAYS=36500

openssl ecparam -name secp384r1 -genkey -noout -out root.key
openssl req -new -x509 -key root.key -sha384 -days $DAYS -subj "/CN=Test Apple Root CA - G3/O=Test Apple Inc./C=US" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out root.pem

openssl ecparam -name prime256v1 -genkey -noout -out intermediate.key
openssl req -new -key intermediate.key -subj "/CN=Test Apple Worldwide Developer Relations CA - G6/O=Test Apple Inc./C=US" -out intermediate.csr
cat > intermediate.ext <<EXT
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
1.2.840.113635.100.6.2.1=DER:05:00
EXT
openssl x509 -req -in intermediate.csr -CA root.pem -CAkey root.key -CAcreateserial -sha384 -days $DAYS -extfile intermediate.ext -out intermediate.pem

openssl ecparam -name prime256v1 -genkey -noout -out leaf.key
openssl req -new -key leaf.key -subj "/CN=Test Prod ECC Mac App Store and iTunes Store Receipt Signing/O=Test Apple Inc./C=US" -out leaf.csr
cat > leaf.ext <<EXT
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
1.2.840.113635.100.6.11.1=DER:05:00
EXT
openssl x509 -req -in leaf.csr -CA intermediate.pem -CAkey intermediate.key -CAcreateserial -sha256 -days $DAYS -extfile leaf.ext -out leaf.pem

# A second, unrelated root so a test can prove a chain to the WRONG anchor is refused.
openssl ecparam -name secp384r1 -genkey -noout -out other-root.key
openssl req -new -x509 -key other-root.key -sha384 -days $DAYS -subj "/CN=Some Other Root/O=Not Apple/C=US" \
  -addext "basicConstraints=critical,CA:TRUE" -out other-root.pem

# The leaf key in PKCS#8 so WebCrypto can import it in the tests.
openssl pkcs8 -topk8 -nocrypt -in leaf.key -out leaf.pkcs8.pem

rm -f intermediate.csr leaf.csr intermediate.ext leaf.ext root.srl intermediate.srl
openssl verify -CAfile root.pem -untrusted intermediate.pem leaf.pem
