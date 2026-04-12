import { z } from 'zod';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY ist erforderlich'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET muss mindestens 32 Zeichen haben'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  DATABASE_PATH: z.string().default('./data/insolvenz.db'),
  UPLOAD_MAX_SIZE_MB: z.coerce.number().default(50),
  RATE_LIMIT_EXTRACTIONS_PER_HOUR: z.coerce.number().default(10),
  DEFAULT_ADMIN_USERNAME: z.string().default('admin'),
  DEFAULT_ADMIN_PASSWORD: z.string().default(''),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  PORT: z.coerce.number().default(3004),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  EXTRACTION_MODEL: z.string().default('claude-sonnet-4-6'),
  UTILITY_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_BASE_URL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().refine(
      (url) => url.startsWith('https://api.anthropic.com') || url.startsWith('https://'),
      { message: 'ANTHROPIC_BASE_URL muss HTTPS verwenden' }
    ).optional()
  ),
  DATA_RETENTION_HOURS: z.coerce.number().default(72),
  DB_ENCRYPTION_KEY: z.string().min(32, 'DB_ENCRYPTION_KEY muss mindestens 32 Zeichen haben (256-bit Hex empfohlen)'),
  // Azure Document Intelligence (optional — enables OCR for scanned PDFs)
  AZURE_DOC_INTEL_ENDPOINT: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().url().optional()
  ),
  AZURE_DOC_INTEL_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional()
  ),
  // Azure Entra ID (optional — if set, enables SSO; if not set, falls back to local password auth)
  AZURE_TENANT_ID: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
});

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Ungültige Umgebungsvariablen:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();
export type Config = z.infer<typeof envSchema>;
