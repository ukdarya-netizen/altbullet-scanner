---
name: API watcher unit-test boundary
description: Why direct Node tests cannot import the API watcher's database-backed module and the supported testing shape.
---

Keep deterministic watcher logic in a focused helper with injected ticker and persistence dependencies; leave the watcher as the production database adapter.

**Why:** The API test runtime resolves the workspace database package to its TypeScript source entrypoint, whose directory import is not supported by plain Node ESM. Importing the full watcher in a unit test therefore fails before mocks can run.

**How to apply:** For new watcher regression tests, import the focused helper rather than the database-backed watcher module. Exercise production persistence through its adapter and test observation/decision logic with a mock store and ticker fetcher.