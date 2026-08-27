---
'kimaki': patch
---

Fix sessions staying permanently stuck on a `<provider>/<model>` id whose provider was disconnected or whose model was deprecated after the session was first bootstrapped. `getCurrentModelInfo` now validates every stored preference (session/agent/channel/global) against the live provider list and surfaces an `invalid` variant; `ensureSessionPreferencesSnapshot` deletes stale session preferences before re-resolving; and the prompt dispatch path (`submitViaOpencodeQueue`) refuses to call `session.promptAsync` with a dead model id, instead posting a Discord message telling the user to run `/model` to pick a new one.
