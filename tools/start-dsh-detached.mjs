#!/usr/bin/env node
// Start a dsh web server fully detached from the calling shell.
//
// Why this exists: every other route on Windows handed the server a console,
// and when the launching shell went away that console got a Ctrl+C which the
// server faithfully died from (the redirect log contained nothing but "^C").
// node's spawn({detached:true, stdio:'ignore', windowsHide:true}) gives the
// child no console at all, so nothing can signal it; it is also the shape the
// extension itself uses in serverManager.
//
// Both legs of the cross-version matrix use this: point DSH_BIN at either the
// 0.1.5 global install or the 0.1.1 fixture under ~/.dsh-011.
//
//   node tools/start-dsh-detached.mjs
//   DSH_BIN=... DSH_PORT=3098 DSH_HOME=... node tools/start-dsh-detached.mjs
import { spawn } from "node:child_process";

const bin = process.env.DSH_BIN
  ?? "C:\\Program Files\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const port = process.env.DSH_PORT ?? "3080";
const home = process.env.DSH_HOME;

const child = spawn(
  process.execPath,
  [bin, "web", "--port", port, "--no-open"],
  {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: home ? { ...process.env, DSH_HOME: home } : process.env,
  },
);
child.unref();
console.log(`spawned pid ${child.pid}  port=${port}${home ? `  DSH_HOME=${home}` : ""}`);
