import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBufferedProcess } from './process-runner.mjs';

const python = join(
  homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime',
  'dependencies', 'python', 'bin', 'python3',
);
const extractor = join(process.cwd(), 'src', 'extract_file_text.py');
const directory = await mkdtemp(join(tmpdir(), 'aipro-extractor-'));

const pageSelection = await runBufferedProcess(python, ['-c', `
import importlib.util, json
spec = importlib.util.spec_from_file_location("extractor", ${JSON.stringify(extractor)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.select_pdf_page_indices(10, 5, frontload=2)))
`], { timeoutMs: 30_000 });
assert.deepEqual(JSON.parse(pageSelection.stdout), [0, 1, 2, 6, 9]);

await runBufferedProcess(python, ['-c', `
from openpyxl import Workbook
from pptx import Presentation
from pypdf import PdfWriter
from docx import Document
from pathlib import Path
root = Path(${JSON.stringify(directory)})
document = Document()
document.add_heading("旧版文档转换", level=1)
document.add_paragraph("DOC 内容已读取")
document.save(root / "legacy-source.docx")
book = Workbook()
sheet = book.active
sheet.title = "经营数据"
sheet.append(["指标", "数值"])
sheet.append(["收入", 42])
book.save(root / "report.xlsx")
deck = Presentation()
slide = deck.slides.add_slide(deck.slide_layouts[1])
slide.shapes.title.text = "季度复盘"
slide.placeholders[1].text = "增长来自海外市场"
deck.save(root / "review.pptx")
writer = PdfWriter()
writer.add_blank_page(width=200, height=200)
with open(root / "scan.pdf", "wb") as output:
    writer.write(output)
(root / "legacy.doc").write_bytes(b"legacy-doc-placeholder")
(root / "legacy.ppt").write_bytes(b"legacy-ppt-placeholder")
`], { timeoutMs: 30_000 });

async function extract(name, options = {}) {
  const { stdout } = await runBufferedProcess(python, [extractor, join(directory, name)], {
    timeoutMs: 30_000,
    env: { ...process.env, ...options.env },
  });
  return JSON.parse(stdout);
}

const spreadsheet = await extract('report.xlsx');
assert.match(spreadsheet.text, /\[工作表：经营数据\]/);
assert.match(spreadsheet.text, /收入\t42/);

const presentation = await extract('review.pptx');
assert.match(presentation.text, /\[幻灯片 1\]/);
assert.match(presentation.text, /季度复盘/);
assert.match(presentation.text, /增长来自海外市场/);

const fakeOfficeConverter = join(directory, 'fake-office-converter.py');
await writeFile(fakeOfficeConverter, `#!/usr/bin/env python3
import shutil, sys
from pathlib import Path
args = sys.argv[1:]
source = Path(args[-1])
target = args[args.index('--convert-to') + 1]
outdir = Path(args[args.index('--outdir') + 1])
seed = source.with_name('legacy-source.docx' if target == 'docx' else 'review.pptx')
shutil.copy2(seed, outdir / f'{source.stem}.{target}')
`);
await chmod(fakeOfficeConverter, 0o700);
const legacyDocument = await extract('legacy.doc', {
  env: { AIPRO_OFFICE_CONVERTER: fakeOfficeConverter },
});
assert.match(legacyDocument.text, /旧版文档转换/);
assert.match(legacyDocument.text, /DOC 内容已读取/);
assert.equal(legacyDocument.officeConverted, true);
const legacyPresentation = await extract('legacy.ppt', {
  env: { AIPRO_OFFICE_CONVERTER: fakeOfficeConverter },
});
assert.match(legacyPresentation.text, /季度复盘/);
assert.equal(legacyPresentation.officeConverted, true);

const fakeOcr = join(directory, 'fake-ocr.py');
await writeFile(fakeOcr, '#!/usr/bin/env python3\nimport json\nprint(json.dumps({"pages":[{"page":1,"text":"扫描件识别结果"}]}, ensure_ascii=False))\n');
await chmod(fakeOcr, 0o700);
const scanned = await extract('scan.pdf', {
  env: { AIPRO_PDF_OCR_COMMAND: fakeOcr },
});
assert.match(scanned.text, /\[PDF 第 1 页 OCR\]/);
assert.match(scanned.text, /扫描件识别结果/);
assert.equal(scanned.ocrUsed, true);

const boundedOcr = join(directory, 'bounded-ocr.py');
await writeFile(boundedOcr, `#!/usr/bin/env python3
import json
print(json.dumps({"pages":[{"page":1,"text":"${'扫描识别长文'.repeat(20)}"}]}, ensure_ascii=False))
`);
await chmod(boundedOcr, 0o700);
const bounded = await extract('scan.pdf', {
  env: { AIPRO_PDF_OCR_COMMAND: boundedOcr, AIPRO_EXTRACT_MAX_CHARS: '25' },
});
assert.equal(bounded.text.length, 25);

console.log('EXTRACT_FILE_TEXT_TEST_OK');
