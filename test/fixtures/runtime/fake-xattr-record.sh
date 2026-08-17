#!/bin/sh
# Fixture standing in for /usr/bin/xattr to PROVE clearDarwinQuarantine() was
# actually invoked, with the arguments it was invoked with. Real xattr does
# not propagate com.apple.quarantine through Node's plain copyFileSync (no
# COPYFILE_CLONE), so a real end-to-end assertion on the attribute itself
# would pass vacuously regardless of whether the clearing code ran at all —
# recording the exact invocation is the only way to test this deterministically.
# FAKE_XATTR_LOG (required) names the file this appends "argv..." to.
if [ -z "$FAKE_XATTR_LOG" ]; then
  echo "fake-xattr-record: FAKE_XATTR_LOG is not set" >&2
  exit 1
fi
echo "$@" >> "$FAKE_XATTR_LOG"
exit 0
