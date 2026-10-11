export async function ensureGoogleApiSuccess(
  response: Pick<Response, 'ok' | 'text'>,
  action: string,
): Promise<void> {
  if (response.ok) return;
  const details = await response.text();
  throw new Error(`Google Sheets ${action} failed: ${details}`);
}
