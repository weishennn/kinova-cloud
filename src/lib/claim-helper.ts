/**
 * Helper utilities for formatting, downloading, and managing receipts in Google Drive for allowance and expense claims.
 */

import { driveApi } from './sheets-api';
import { getLocalDateString } from './date-helper';

export function formatClaimFileName(
  date: string,
  category: string,
  amount: number,
  description: string,
  originalName?: string
): string {
  const cleanDate = date || getLocalDateString();
  const cleanCat = (category || 'Expense').replace(/[^a-zA-Z0-9]/g, '');
  const cleanDesc = (description || category || 'Receipt')
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fa5]/g, '_')
    .substring(0, 25);
  const formattedAmt = `RM${amount.toFixed(2)}`;
  
  let ext = 'jpg';
  if (originalName && originalName.toLowerCase().endsWith('.pdf')) {
    ext = 'pdf';
  }

  return `CLAIM_${cleanDate}_${cleanCat}_${formattedAmt}_${cleanDesc}.${ext}`;
}

/**
 * Extracts Google Drive file ID from various Drive URL formats.
 */
export function extractDriveFileId(url: string): string | null {
  if (!url) return null;
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/) || url.match(/id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

/**
 * Resolves a direct, high-speed image thumbnail URL for Google Drive files and images.
 */
export function getReceiptThumbnailUrl(url: string, size: number = 800): string {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('blob:')) {
    return url;
  }
  const fileId = extractDriveFileId(url);
  if (fileId) {
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w${size}`;
  }
  return url;
}

/**
 * Downloads a receipt file directly with the standardized claim file name.
 */
export async function downloadReceiptFile(url: string, desiredFilename: string) {
  if (!url) return;

  try {
    // 1. Data URLs (base64)
    if (url.startsWith('data:')) {
      const a = document.createElement('a');
      a.href = url;
      a.download = desiredFilename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return;
    }

    // 2. Google Drive URLs
    const fileId = extractDriveFileId(url);
    const downloadUrl = fileId
      ? `https://drive.google.com/uc?export=download&id=${fileId}`
      : url;

    // Fetch as blob to enforce custom clean filename
    try {
      const response = await fetch(downloadUrl);
      if (response.ok) {
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = desiredFilename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        return;
      }
    } catch {
      // CORS or network error, fallback to direct anchor or window.open
    }

    // Fallback: direct anchor download
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.target = '_blank';
    a.download = desiredFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    console.error('Download error:', err);
    window.open(url, '_blank');
  }
}

/**
 * Downloads a batch of receipts sequentially with an optional progress callback.
 */
export async function downloadReceiptBatch(
  items: Array<{ url: string; filename: string }>,
  onProgress?: (current: number, total: number) => void
): Promise<void> {
  const total = items.length;
  for (let i = 0; i < total; i++) {
    const item = items[i];
    onProgress?.(i + 1, total);
    await downloadReceiptFile(item.url, item.filename);
    // Pause briefly between downloads to prevent browser throttling
    if (i < total - 1) {
      await new Promise((r) => setTimeout(r, 450));
    }
  }
}

/**
 * Deletes a receipt file from Google Drive via fileId or Drive URL.
 */
export async function deleteDriveReceipt(urlOrFileId: string): Promise<boolean> {
  if (!urlOrFileId) return false;
  const fileId = urlOrFileId.includes('/') || urlOrFileId.includes('?') || urlOrFileId.includes('.')
    ? extractDriveFileId(urlOrFileId)
    : urlOrFileId;

  if (!fileId) return false;

  try {
    const res = await driveApi.deleteFile(fileId);
    return Boolean(res?.success);
  } catch (err) {
    console.error('Error deleting file from Google Drive:', err);
    return false;
  }
}
