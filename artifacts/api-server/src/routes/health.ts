import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  // Publishing uses this route as the process startup/readiness probe. Scanner
  // health is supervised independently by the watcher watchdog; coupling it to
  // HTTP readiness can reject a healthy new VM during a temporary market/DB
  // control-plane degradation and leave the public deployment unreachable.
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
