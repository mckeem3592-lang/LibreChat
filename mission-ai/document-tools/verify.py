from importlib.metadata import version

EXPECTED = {
    "openpyxl": "3.1.5",
    "python-docx": "1.2.0",
    "python-pptx": "1.0.2",
    "pypdf": "6.19.0",
    "reportlab": "5.0.1",
}

for package, expected in EXPECTED.items():
    actual = version(package)
    if actual != expected:
        raise SystemExit(f"{package}: expected {expected}, got {actual}")

from docx import Document
from openpyxl import Workbook
from pptx import Presentation
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas

assert Document is not None
assert Workbook is not None
assert Presentation is not None
assert PdfReader is not None
assert PdfWriter is not None
assert canvas is not None

print("Mission AI document toolchain verified.")
