# Mission AI Spreadsheet Creator

The paid Mission AI presets expose `create_spreadsheet` as a separate, owner-scoped
MCP tool. It builds a new XLSX workbook from explicit cell values in memory,
then sends the bytes to LibreChat's existing edited-document publisher over
localhost. It never reads a pre-existing workbook or a device folder.

LibreChat injects the authenticated user's ID into the stdio process environment.
The process also needs the existing `LOCAL_MCP_TOKEN` and the chat server's
`PORT`. The upload endpoint resolves the user from its database and stores the
workbook in GridFS. The resulting download link is private and expires under the
existing edited-document retention setting. No credential or binary data enters
the model's tool result.

The tool accepts at most 1,000 plain string, number, or boolean cells in columns
A through ZZ and rows 1 through 9999. Strings beginning with `=` remain text,
not formulas. The output is capped at 5 MiB. LibreChat requires a per-action
approval before calling the tool. The browser download path still needs separate
live verification; this tool does not repair that path.
