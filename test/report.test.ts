import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { saveReport } from "../src/server/report.js";

vi.mock("node:fs", () => ({ mkdirSync: vi.fn(), writeFileSync: vi.fn() }));

it.each([
  { write: mkdirSync, code: "EPERM" },
  { write: mkdirSync, code: "ENOENT" },
  { write: writeFileSync, code: "EACCES" },
  { write: writeFileSync, code: "EROFS" },
])("explains how to recover from a report write error ($code)", ({ write, code }) => {
  const dir = "custom reports";
  vi.mocked(write).mockImplementationOnce(() => {
    throw Object.assign(new Error("The file system refused the write"), { code });
  });

  expect(() => saveReport({}, dir)).toThrow(
    `Forma MCP could not save the report in "${resolve(dir)}" (${code}).\n` +
    'fix: Choose another folder by setting the FORMA_MCP_REPORT_DIR environment variable, or check that this folder is writable and that Windows "Controlled folder access" allows Forma MCP to write there.',
  );
});
