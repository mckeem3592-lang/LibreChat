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


## Verification

`verify.py` checks the pinned package versions and performs disposable round-trip
creation/reopen tests for XLSX, DOCX, PPTX, and PDF inside a temporary directory.
It does not read or modify user documents.

## Downloadable edited files

The Local Documents MCP `publish_document(root, path)` tool publishes an existing
DOCX, XLSX, or PDF without putting its binary content in a model response. LibreChat
passes its authenticated user ID to that MCP server through the configured
`X-LibreChat-User-ID` header. The MCP server uses its existing `LOCAL_MCP_TOKEN` to
POST the original bytes to `/api/files/edited/mcp`; the API resolves that user from
its database and stores the file under the user's local upload directory. The tool
returns an `/api/files/edited/:file_id` URL, which requires that user's LibreChat
session to download. A normal signed-in browser can also POST multipart field
`file` to `/api/files/edited`.

The upload size uses the existing `fileConfig.serverFileSizeLimit`. Only DOCX,
XLSX, and PDF extensions with matching ZIP or PDF signatures are accepted. The
server sanitizes filenames, serves downloads as attachments, and removes records
and bytes through the existing file retention sweep. The deadline defaults to 24
hours and can be set with `editedDocumentRetentionHours` (1–168) in `librechat.yaml`.

This is an ephemeral-storage prototype: a Render restart, redeploy, or instance
change can erase the bytes before their retention deadline. Existing file records
may then yield unavailable downloads. Keep the local original until the recipient
has downloaded and verified the file.
