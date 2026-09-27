# Mission AI Document Tools

This toolchain is installed once on the personal Mac and then used from the
workspace-scoped LibreChat code worker. It does not grant the native companion
additional filesystem access.

Pinned libraries:

- openpyxl 3.1.5 — Excel workbooks
- python-docx 1.2.0 — Word documents
- python-pptx 1.0.2 — PowerPoint presentations
- pypdf 6.19.0 — PDF reading/editing/merging
- reportlab 5.0.1 — PDF creation

The code worker remains the security boundary. Only files inside an attached,
approved workspace should be opened or modified. Preserve originals unless the
user explicitly intends an in-place replacement.
