// Opens the recording profile so a human can sign in. Stays open until tmp/login-done exists.
import fs from "node:fs";
import { openBrowser } from "./browser.mjs";

const ctx = await openBrowser();
const a = await ctx.newPage();
await a.goto("https://keepercard-dashboard.adoranto737.workers.dev/app");
const b = await ctx.newPage();
await b.goto("https://app.keeperhub.com/workflows");
console.log("sign in to both tabs; waiting for tmp/login-done");
while (!fs.existsSync("tmp/login-done")) await new Promise((r) => setTimeout(r, 1000));
await ctx.close();
console.log("profile saved");
