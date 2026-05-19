import Database from "better-sqlite3";
import { getCostSummary, getCollectionMetadata, getUsageTotals, getCostByAgent } from "./src/lib/usage-queries";
import path from "path";

const DB_PATH = path.join(process.cwd(), "data", "usage-tracking.db");
const db = new Database(DB_PATH, { readonly: true });

try {
  const summary = getCostSummary(db);
  const metadata = getCollectionMetadata(db);
  const totals = getUsageTotals(db, 30);
  const byAgent = getCostByAgent(db, 30);
  
  const obj = { summary, metadata, totals, byAgent };
  
  function checkBigInt(o, path) {
    if (typeof o === "bigint") console.log(`Found BigInt at ${path}`);
    else if (typeof o === "object" && o !== null) {
      for (const k in o) checkBigInt(o[k], `${path}.${k}`);
    }
  }
  
  checkBigInt(obj, "root");
  
  console.log("JSON:", JSON.stringify(obj));
} catch (e) {
  console.error("Error:", e);
} finally {
  db.close();
}
