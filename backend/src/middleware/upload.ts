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

export const uploadMiddleware = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.UPLOAD_MAX_SIZE_MB * 1024 * 1024,
  },
}).single('pdf');
