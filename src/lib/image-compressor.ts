/**
 * Client-side high performance image compression utility.
 * Downscales large mobile camera photos (e.g. 12MP, 8-12MB) to crisp, web-optimized
 * receipts (~200KB-400KB) before uploading to Google Drive via Google Apps Script.
 * Prevents network timeouts, payload limits, and memory crashes on mobile browsers.
 */

export interface CompressionOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number; // 0.1 to 1.0, default 0.8
}

export async function compressImageFile(
  file: File,
  options: CompressionOptions = {}
): Promise<{ base64: string; dataUrl: string; mimeType: string }> {
  const { maxWidth = 1600, maxHeight = 2000, quality = 0.8 } = options;

  // If it's a PDF, we cannot canvas-compress; read directly as DataURL
  if (file.type === 'application/pdf') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1] || '';
        resolve({ base64, dataUrl, mimeType: 'application/pdf' });
      };
      reader.onerror = () => reject(new Error('Failed to read PDF file'));
      reader.readAsDataURL(file);
    });
  }

  // If it's not an image (or browser doesn't support canvas), fallback to FileReader
  if (!file.type.startsWith('image/')) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1] || '';
        resolve({ base64, dataUrl, mimeType: file.type || 'application/octet-stream' });
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let width = img.width;
      let height = img.height;

      // Calculate constrained dimensions strictly preserving aspect ratio
      if (width > maxWidth || height > maxHeight) {
        const ratio = Math.min(maxWidth / width, maxHeight / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        // Fallback if canvas context fails
        const fallbackReader = new FileReader();
        fallbackReader.onload = () => {
          const dataUrl = fallbackReader.result as string;
          resolve({
            base64: dataUrl.split(',')[1] || '',
            dataUrl,
            mimeType: file.type || 'image/jpeg',
          });
        };
        fallbackReader.readAsDataURL(file);
        return;
      }

      // High-quality image rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, width, height);

      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const base64 = dataUrl.split(',')[1] || '';

      resolve({
        base64,
        dataUrl,
        mimeType: 'image/jpeg',
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      // Fallback on image load error
      const fallbackReader = new FileReader();
      fallbackReader.onload = () => {
        const dataUrl = fallbackReader.result as string;
        resolve({
          base64: dataUrl.split(',')[1] || '',
          dataUrl,
          mimeType: file.type || 'image/jpeg',
        });
      };
      fallbackReader.readAsDataURL(file);
    };

    img.src = objectUrl;
  });
}
