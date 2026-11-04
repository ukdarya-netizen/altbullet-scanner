import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scannerRouter from "./scanner.js";
import signalsRouter from "./signals.js";
import settingsRouter from "./settings.js";
import subscribersRouter from "./subscribers.js";
import trackerRouter from "./tracker.js";
import liqCascadeRouter from "./liq-cascade.js";
import authRouter from "./auth.js";
import clientErrorsRouter from "./client-errors.js";
import tradingCommandsRouter from "./trading-commands.js";
import signalsExportRouter from "./signals-export.js";
const router: IRouter = Router();

router.use(healthRouter);
router.use(scannerRouter);
router.use(signalsRouter);
router.use(settingsRouter);
router.use(subscribersRouter);
router.use(trackerRouter);
router.use(liqCascadeRouter);
router.use(authRouter);
router.use(clientErrorsRouter);
router.use(tradingCommandsRouter);
router.use(signalsExportRouter);

export default router;
