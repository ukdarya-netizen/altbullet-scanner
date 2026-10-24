import { Router, type IRouter } from "express";
import {
  ReportBootstrapErrorBody,
  ReportClientErrorBody,
} from "@workspace/api-zod";
import { createClientErrorAdmission } from "../lib/client-error-admission.js";
import {
  sanitizeClientErrorRoute,
  sanitizeClientErrorText,
} from "../lib/client-error-sanitization.js";

const router: IRouter = Router();
const admitClientError = createClientErrorAdmission();
const admitBootstrapError = createClientErrorAdmission();

router.post("/bootstrap-errors", (req, res): void => {
  const parsed = ReportBootstrapErrorBody.strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid bootstrap error report" });
    return;
  }

  const report = parsed.data;
  const route = sanitizeClientErrorRoute(report.route);
  const admission = admitBootstrapError(
    `${report.code}:${route}:${report.browserFamily}:${report.browserVersion}:${report.appVersion}`,
  );
  if (admission === "rate_limited") {
    res.status(429).json({ error: "Too many bootstrap error reports" });
    return;
  }
  if (admission === "accept") {
    req.log.error(
      {
        event: "dashboard_bootstrap_error",
        code: report.code,
        route,
        appVersion: report.appVersion,
        browserFamily: report.browserFamily,
        browserVersion: report.browserVersion,
      },
      "Anonymous dashboard bootstrap failed",
    );
  }

  res.status(202).json({ accepted: true });
});

router.post("/client-errors", (req, res): void => {
  const parsed = ReportClientErrorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid client error report" });
    return;
  }

  const report = parsed.data;
  const route = sanitizeClientErrorRoute(report.route);
  const message = sanitizeClientErrorText(report.message, 240);
  const component = sanitizeClientErrorText(report.component, 120);
  const admission = admitClientError(
    `${report.fingerprint}:${report.kind}:${route}:${report.browserFamily}:${report.appVersion}`,
  );
  if (admission === "rate_limited") {
    res.status(429).json({ error: "Too many client error reports" });
    return;
  }
  if (admission === "accept") {
    req.log.error(
      {
        event: "dashboard_client_error",
        kind: report.kind,
        route,
        appVersion: report.appVersion,
        browserFamily: report.browserFamily,
        fingerprint: report.fingerprint,
        occurredAt: report.occurredAt,
        message,
        component,
        httpStatus: report.httpStatus,
      },
      "Authenticated dashboard client failed",
    );
  }

  res.status(202).json({ accepted: true });
});

export default router;
