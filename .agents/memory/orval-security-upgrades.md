---
name: Orval security upgrades
description: Ограничения безопасного обновления Orval в workspace с Zod 3 и детерминированным codegen.
---

Orval нужно обновлять до версии без critical advisory, но явно фиксировать `override.zod.version: 3` и не использовать новый workspace barrel для пакетов с ручным `index.ts`.

**Why:** новый Orval без явной версии Zod fallback’ится на Zod 4 в изолированном drift-run, а `workspace` автоматически дописывает конфликтующие exports. Некоторые безопасные версии также оставляют лишние переводы строки в generated-файлах.

**How to apply:** после изменения Orval запускай обычный codegen и изолированный drift-check; оба пути должны применять одинаковую версию Zod, target layout и нормализацию EOF до typecheck/build.