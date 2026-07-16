---
"kimaki": patch
---

Rename `--permission-timeout-minutes` to `--interaction-timeout-minutes` with `KIMAKI_INTERACTION_TIMEOUT_MINUTES` env var

The renamed flag now controls both permission buttons and question dropdown timeouts (not just permissions). The old `--permission-timeout-minutes` flag is removed.
