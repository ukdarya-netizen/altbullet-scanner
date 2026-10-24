---
name: Deployment target verification
description: How to confirm that a Reserved VM target actually became the active public deployment.
---

Treat the published deployment metadata as authoritative over artifact configuration. A project can retain an active Autoscale deployment even when its artifact configuration says `deploymentTarget = "vm"`.

**Why:** Publishing configuration and the live deployment record can diverge; relying on the repository setting alone leaves scheduler recovery assumptions unverified.

**How to apply:** After any target change, query deployment metadata and confirm `deploymentType` is `vm`. If it remains `autoscale`, select Reserved VM in the Publishing UI, publish again, then re-check metadata before relying on VM restart behavior.