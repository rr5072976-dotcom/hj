import { Router, type IRouter } from "express";
import healthRouter from "./health";
import gmailRouter from "./gmail";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/gmail", gmailRouter);

export default router;
