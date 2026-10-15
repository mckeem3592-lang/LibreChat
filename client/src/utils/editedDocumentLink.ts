const editedPath = /^\/api\/files\/edited\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function getEditedDocumentLink(href: string, baseUrl: string, pageOrigin: string) {
  try {
    const base = new URL(baseUrl || '/', pageOrigin);
    const url = new URL(href, pageOrigin);
    const basePath = base.pathname.replace(/\/$/, '');
    const path = url.pathname.startsWith(basePath)
      ? url.pathname.slice(basePath.length)
      : '';
    const match = editedPath.exec(path);
    if (url.origin !== base.origin || url.search || url.hash || !match) {
      return null;
    }
    return { url: url.href, fileId: match[1] };
  } catch {
    return null;
  }
}

export function getEditedDocumentFilename(
  disposition: string | undefined,
  contentType: string | undefined,
  fileId: string,
) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  let filename = '';
  try {
    filename = decodeURIComponent(encoded ?? plain ?? '');
  } catch {
    filename = plain ?? '';
  }
  filename = filename.split(/[\\/]/).pop()?.trim() ?? '';
  if (/^[^\x00-\x1f]+\.(?:docx|xlsx|pdf)$/i.test(filename)) {
    return filename;
  }

  const type = contentType?.toLowerCase() ?? '';
  const extension = type.includes('spreadsheet')
    ? 'xlsx'
    : type.includes('pdf')
      ? 'pdf'
      : 'docx';
  return `edited-${fileId}.${extension}`;
}
