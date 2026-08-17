#!/bin/sh
# Fixture standing in for /usr/bin/xattr when a test needs to prove that
# installRuntime() refuses to publish if clearing com.apple.quarantine fails.
# Real xattr never behaves this way — this only exists so the failure path
# can be exercised deterministically without depending on a real quarantined
# file on the test machine. See AGENT_INBOX_XATTR_BIN in runtime-payload.mjs.
echo "fake-xattr-fail: simulated xattr failure" >&2
exit 1
