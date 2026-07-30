#!/usr/bin/env python3
import json
import sys
from pathlib import Path

MAX_CHARS = 40000
MAX_PDF_PAGES = 60


def docx_text(path: Path) -> str:
    from docx import Document

    document = Document(path)
    chunks = [p.text.strip() for p in document.paragraphs if p.text.strip()]
    for table in document.tables:
        for row in table.rows:
            values = [cell.text.strip().replace("\n", " ") for cell in row.cells]
            if any(values):
                chunks.append("\t".join(values))
    return "\n".join(chunks)


def pdf_text(path: Path) -> str:
    from pypdf import PdfReader

    reader = PdfReader(path)
    chunks = []
    for page in reader.pages[:MAX_PDF_PAGES]:
        chunks.append(page.extract_text() or "")
        if sum(len(item) for item in chunks) >= MAX_CHARS:
            break
    return "\n".join(chunks)


def plain_text(path: Path) -> str:
    raw = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "gb18030", "big5"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: extract_file_text.py FILE")
    path = Path(sys.argv[1])
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        text = pdf_text(path)
    elif suffix == ".docx":
        text = docx_text(path)
    elif suffix in {".txt", ".md", ".csv", ".json", ".log", ".xml", ".html"}:
        text = plain_text(path)
    else:
        raise ValueError(f"unsupported extension: {suffix or '(none)'}")
    normalized = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    print(json.dumps({"text": normalized[:MAX_CHARS], "chars": len(normalized)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
