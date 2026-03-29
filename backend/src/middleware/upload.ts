import multer from 'multer';
import { config } from '../config';

const storage = multer.memoryStorage();

function fileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
): void {
  if (file.mimetype !== 'application/pdf') {
    cb(new Error('Nur PDF-Dateien werden akzeptiert.'));
    return;
  }
  cb(null, true);
}

/** Validate PDF magic bytes (%PDF) after multer has loaded the buffer */
export function validatePdfBuffer(buffer: Buffer): void {
  const PDF_MAGIC = Buffer.from('%PDF');
  if (!buffer.subarray(0, 4).equals(PDF_MAGIC)) {
    throw new Error('Datei ist kein gültiges PDF (ungültiger Dateiheader).');
  }
}

export const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.UPLOAD_MAX_SIZE_MB * 1024 * 1024,
  },
}).single('pdf');
