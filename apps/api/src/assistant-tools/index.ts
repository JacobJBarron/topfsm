/** Every tool the MCP server (mcp.ts) offers, by name. */
import { automationTools } from "./automations";
import { bookingTools } from "./booking";
import { checklistTools } from "./checklists";
import { clientTools } from "./clients";
import { companyTools } from "./company";
import { crewTools } from "./crews";
import { guideTools } from "./guides";
import { invoiceTools } from "./invoices";
import { jobTools } from "./jobs";
import { marketingTools } from "./marketing";
import { payTools } from "./pay";
import { priceTools } from "./prices";
import { quoteTools } from "./quotes";
import { recordTools } from "./records";
import { reportTools } from "./reports";
import { scheduleTools } from "./schedule";
import { templateTools } from "./templates";
import { teamTools } from "./team";
import { timeTools } from "./time";
import type { AnyTool } from "./tool";

export const TOOLS: Record<string, AnyTool> = {
  ...recordTools,
  ...clientTools,
  ...jobTools,
  ...scheduleTools,
  ...reportTools,
  ...quoteTools,
  ...invoiceTools,
  ...teamTools,
  ...timeTools,
  ...payTools,
  ...companyTools,
  ...priceTools,
  ...crewTools,
  ...checklistTools,
  ...bookingTools,
  ...guideTools,
  ...automationTools,
  ...templateTools,
  ...marketingTools,
};

export { friendly, rows, type AnyTool, type ToolContext } from "./tool";
