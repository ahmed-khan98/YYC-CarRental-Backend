import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const LINUX_SOFFICE_CANDIDATES = [
  process.env.SOFFICE_PATH,
  "soffice",
  "libreoffice",
  "/usr/bin/soffice",
  "/usr/bin/libreoffice",
  "/usr/lib/libreoffice/program/soffice",
  "/opt/libreoffice/program/soffice",
].filter(Boolean);

async function commandExists(bin) {
  try {
    await execFileAsync(bin, ["--version"], { timeout: 15_000 });
    return true;
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    return err?.code !== "ENOENT";
  }
}

async function resolveSofficeBin() {
  for (const bin of LINUX_SOFFICE_CANDIDATES) {
    if (await commandExists(bin)) return bin;
  }
  return null;
}

/**
 * Convert a DOCX buffer to PDF.
 * Windows: Microsoft Word COM. Other platforms: LibreOffice (soffice).
 */
export async function convertDocxToPdf(docxBuffer) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "yyc-docx-"));
  const docxPath = path.join(tmpDir, "agreement.docx");
  const pdfPath = path.join(tmpDir, "agreement.pdf");

  try {
    await fs.writeFile(docxPath, docxBuffer);

    if (process.platform === "win32") {
      const psScript = path.join(tmpDir, "convert.ps1");
      await fs.writeFile(
        psScript,
        `
param([string]$DocxPath, [string]$PdfPath)
$ErrorActionPreference = "Stop"
$word = New-Object -ComObject Word.Application
$word.Visible = $false
try {
  $doc = $word.Documents.Open($DocxPath)
  $doc.SaveAs2($PdfPath, 17)
  $doc.Close()
} finally {
  $word.Quit()
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
}
`,
      );
      await execFileAsync(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-File", psScript, docxPath, pdfPath],
        { timeout: 90_000 },
      );
    } else {
      const soffice = await resolveSofficeBin();
      if (!soffice) {
        const error = new Error(
          "LibreOffice is not installed on this server. Install it with: sudo apt-get install -y libreoffice-writer",
        );
        error.code = "SOFFICE_MISSING";
        throw error;
      }
      await execFileAsync(
        soffice,
        ["--headless", "--nologo", "--nofirststartwizard", "--convert-to", "pdf", "--outdir", tmpDir, docxPath],
        { timeout: 120_000 },
      );
    }

    return await fs.readFile(pdfPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
