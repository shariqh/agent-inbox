#!/bin/sh
# Fixture for test/runtime-payload.test.ts — a stand-in "node" binary used to
# exercise scripts/stage-runtime.mjs's validateNodeDistribution() without
# needing a real Node distribution for every platform/arch/version under
# test (in particular a real x64 build on this arm64 host). It ignores the
# `-e <script>` arguments stage-runtime.mjs's probe passes and always prints
# the same JSON shape a real `node -e "console.log(JSON.stringify({...}))"`
# would, driven entirely by FAKE_* env vars the test sets per case.
printf '{"platform":"%s","arch":"%s","version":"%s","modulesAbi":"%s"}' \
  "${FAKE_PLATFORM:-darwin}" "${FAKE_ARCH:-arm64}" "${FAKE_VERSION:-v24.0.0}" "${FAKE_MODULES_ABI:-137}"
