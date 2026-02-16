/**
 * @fileoverview Schemas de validación usando Zod para validación robusta de parámetros IPC
 * @module schemas
 */

import { z } from 'zod';
import { VALIDATIONS } from '../constants/validations';

export interface ZodValidationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

const searchSchema = z.object({
  searchTerm: z
    .string()
    .min(2, VALIDATIONS.SEARCH.TERM_MIN_LENGTH)
    .max(100, VALIDATIONS.SEARCH.TERM_MAX_LENGTH)
    .transform(val => val.trim()),
});

const nodeIdSchema = z
  .number()
  .int(VALIDATIONS.ID.MUST_BE_INTEGER)
  .positive(VALIDATIONS.ID.MUST_BE_POSITIVE);

const downloadParamsSchema = z.object({
  id: z
    .number()
    .int(VALIDATIONS.ID.MUST_BE_INTEGER)
    .positive(VALIDATIONS.ID.DOWNLOAD_MUST_BE_POSITIVE_ALT),

  title: z
    .string()
    .min(1, VALIDATIONS.TITLE.CANNOT_BE_EMPTY)
    .max(500, VALIDATIONS.TITLE.TOO_LONG)
    .transform(val => val.trim()),

  downloadPath: z.string().max(1000, VALIDATIONS.PATH.TOO_LONG).optional().nullable(),

  preserveStructure: z.boolean().optional().default(false),

  forceOverwrite: z.boolean().optional().default(false),
});

const downloadIdSchema = z.coerce
  .number()
  .int(VALIDATIONS.ID.DOWNLOAD_MUST_BE_INTEGER)
  .positive(VALIDATIONS.ID.DOWNLOAD_MUST_BE_POSITIVE);

const configFilenameSchema = z
  .string()
  .min(1, VALIDATIONS.FILE.FILENAME_CANNOT_BE_EMPTY)
  .max(100, VALIDATIONS.FILE.FILENAME_TOO_LONG)
  .regex(/^[a-zA-Z0-9_-]+\.json$/, VALIDATIONS.FILE.FILENAME_INVALID_FORMAT);

const configDataSchema = z
  .record(z.string(), z.unknown())
  .refine((data: unknown): data is Record<string, unknown> => {
    try {
      JSON.stringify(data);
      return true;
    } catch {
      return false;
    }
  }, VALIDATIONS.DATA.MUST_BE_SERIALIZABLE);

export function validate<T>(schema: z.ZodSchema<T>, data: unknown): ZodValidationResult<T> {
  try {
    const result = schema.safeParse(data);

    if (result.success) {
      return {
        success: true,
        data: result.data,
      };
    }
    const issues = result.error.issues ?? [];
    const errorMessages = issues.map((err: z.ZodIssue) => {
      const path = err.path as (string | number)[];
      const pathStr = path && path.length > 0 ? `${path.join('.')}: ` : '';
      return `${pathStr}${err.message}`;
    });

    return {
      success: false,
      error: errorMessages.join('; '),
    };
  } catch (error) {
    return {
      success: false,
      error: `${VALIDATIONS.GENERIC.VALIDATION_ERROR}: ${(error as Error).message}`,
    };
  }
}

export function validateSearch(searchTerm: string): ZodValidationResult<{ searchTerm: string }> {
  return validate(searchSchema, { searchTerm });
}

export function validateNodeId(nodeId: unknown): ZodValidationResult<number> {
  return validate(nodeIdSchema, nodeId);
}

export function validateDownloadParams(
  params: unknown
): ZodValidationResult<z.infer<typeof downloadParamsSchema>> {
  return validate(downloadParamsSchema, params);
}

// --- Schemas adicionales (validación Zod) ---

const downloadFolderParamsSchema = z.object({
  folderId: z
    .number()
    .int(VALIDATIONS.ID.MUST_BE_INTEGER)
    .positive(VALIDATIONS.ID.MUST_BE_POSITIVE),
  downloadPath: z.string().max(1000, VALIDATIONS.PATH.TOO_LONG).optional().nullable(),
  preserveStructure: z.boolean().optional().default(true),
  forceOverwrite: z.boolean().optional().default(false),
  deferStart: z.boolean().optional().default(false),
});

const downloadSettingsSchema = z.object({
  maxParallelDownloads: z.number().int().min(1).max(10).optional(),
  maxConcurrentChunks: z.number().int().min(1).max(16).optional(),
  maxChunkRetries: z.number().int().min(0).max(50).optional(),
  chunkOperationTimeoutMinutes: z.number().min(0.5).max(60).optional(),
  skipVerification: z.boolean().optional(),
  disableChunkedDownloads: z.boolean().optional(),
  turboDownload: z.boolean().optional(),
});

export function validateDownloadFolderParamsZod(
  params: unknown
): ZodValidationResult<z.infer<typeof downloadFolderParamsSchema>> {
  return validate(downloadFolderParamsSchema, params);
}

export function validateDownloadSettings(
  params: unknown
): ZodValidationResult<z.infer<typeof downloadSettingsSchema>> {
  return validate(downloadSettingsSchema, params);
}

export function validateDownloadId(downloadId: unknown): ZodValidationResult<number> {
  return validate(downloadIdSchema, downloadId);
}

export function validateConfigFilename(filename: unknown): ZodValidationResult<string> {
  return validate(configFilenameSchema, filename);
}

export function validateConfigData(data: unknown): ZodValidationResult<Record<string, unknown>> {
  return validate(configDataSchema, data);
}

export const schemas = {
  search: searchSchema,
  nodeId: nodeIdSchema,
  downloadParams: downloadParamsSchema,
  downloadId: downloadIdSchema,
  configFilename: configFilenameSchema,
  configData: configDataSchema,
  downloadFolderParams: downloadFolderParamsSchema,
  downloadSettings: downloadSettingsSchema,
};
