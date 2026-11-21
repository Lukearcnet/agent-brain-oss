"use strict";
/**
 * Keep launchd's stdout/stderr logs bounded.
 *
 * launchd opens StandardOutPath/StandardErrorPath in append mode and keeps the
 * descriptor for the life of the process, so we can't rename-and-reopen.
 * Instead: when a log passes MAX_BYTES, save its last KEEP_BYTES to
 * "<name>.1" and truncate the live file in place. With O_APPEND the next write
 * lands at the new end of file, so the file really shrinks.
 */

const fs = require("fs");
const path = require("path");

const MAX_BYTES = 50 * 1024 * 1024;
const KEEP_BYTES = 5 * 1024 * 1024;

function rotateIfLarge(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return false; }
  if (st.size <= MAX_BYTES) return false;
  try {
    const fd = fs.openSync(file, "r");
    const len = Math.min(KEEP_BYTES, st.size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    fs.writeFileSync(file + ".1", buf);
    fs.truncateSync(file, 0);
    return true;
  } catch (e) {
    process.stderr.write(`[log-rotate] ${path.basename(file)}: ${e.message}\n`);
    return false;
  }
}

function start(logDir) {
  const run = () => {
    for (const name of ["stdout.log", "stderr.log"]) {
      if (rotateIfLarge(path.join(logDir, name))) {
        console.log(`[log-rotate] ${name} exceeded ${MAX_BYTES / 1048576}MB — kept last ${KEEP_BYTES / 1048576}MB in ${name}.1`);
      }
    }
  };
  run();
  const t = setInterval(run, 15 * 60 * 1000);
  if (t.unref) t.unref();
}

module.exports = { start, rotateIfLarge };
