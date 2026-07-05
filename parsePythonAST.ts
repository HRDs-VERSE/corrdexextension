import { execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import type { ASTMetadata } from "./parseAST.js";
import { fileURLToPath } from "url";

const _filename = typeof __filename !== 'undefined' ? __filename : fileURLToPath((import.meta as any).url || 'file://');
const _dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(_filename);

export function parsePythonAST(filePath: string): ASTMetadata {
  const pythonScriptPath = resolvePythonScriptPath();

  try {
    // Run the python script synchronously
    const output = execFileSync("python", [pythonScriptPath, filePath], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const parsed = JSON.parse(output);
    if (parsed.error) {
      throw new Error(`Python AST parsing error: ${parsed.error}`);
    }

    return parsed as ASTMetadata;
  } catch (error: any) {
    throw new Error(`Failed to parse Python AST for ${filePath}: ${error.message}`);
  }
}

export function parsePythonASTContent(content: string, originalFilePath: string = "inline.py"): ASTMetadata {
  const tempId = crypto.randomBytes(8).toString("hex");
  const safeBaseName = path.basename(originalFilePath).replace(/[^a-zA-Z0-9._-]/g, "_") || "inline.py";
  const tempFilePath = path.join(os.tmpdir(), `corrdex_py_inline_${tempId}_${safeBaseName.endsWith(".py") ? safeBaseName : `${safeBaseName}.py`}`);

  try {
    fs.writeFileSync(tempFilePath, content, "utf-8");
    return parsePythonAST(tempFilePath);
  } finally {
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch {}
    }
  }
}

export function parsePythonASTBatch(filePaths: string[]): Record<string, ASTMetadata> {
  if (filePaths.length === 0) return {};

  const pythonScriptPath = resolvePythonScriptPath();
  const tempId = crypto.randomBytes(8).toString("hex");
  const tempFilePath = path.join(os.tmpdir(), `corrdex_py_batch_${tempId}.json`);
  const tempOutFilePath = path.join(os.tmpdir(), `corrdex_py_batch_out_${tempId}.json`);

  try {
    // Write file paths to temp JSON
    fs.writeFileSync(tempFilePath, JSON.stringify(filePaths), "utf-8");

    // Run batch script synchronously. We use an output file to avoid stdout maxBuffer issues (ENOBUFS)
    execFileSync("python", [pythonScriptPath, "--batch", tempFilePath, tempOutFilePath], {
      encoding: "utf-8",
      stdio: "inherit",
    });

    if (!fs.existsSync(tempOutFilePath)) {
      throw new Error("Python parser failed to create output file");
    }

    const outputContent = fs.readFileSync(tempOutFilePath, "utf-8");
    const parsed = JSON.parse(outputContent);
    return parsed as Record<string, ASTMetadata>;
  } catch (error: any) {
    throw new Error(`Failed to run Python batch AST parsing: ${error.message}`);
  } finally {
    if (fs.existsSync(tempFilePath)) {
      try { fs.unlinkSync(tempFilePath); } catch (e) {}
    }
    if (fs.existsSync(tempOutFilePath)) {
      try { fs.unlinkSync(tempOutFilePath); } catch (e) {}
    }
  }
}

function resolvePythonScriptPath(): string {
  let pythonScriptPath = path.resolve(_dirname, "./python_ast_parser.py");
  if (!fs.existsSync(pythonScriptPath)) {
    pythonScriptPath = path.resolve(_dirname, "../python_ast_parser.py");
  }
  return pythonScriptPath;
}

