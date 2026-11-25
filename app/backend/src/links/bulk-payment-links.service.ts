import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { LinksService } from './links.service';
import { FeatureFlagsService } from '../feature-flags/feature-flags.service';
import {
  BulkPaymentLinkItemDto,
  BulkPaymentLinkResponseItemDto,
  BulkPaymentLinkResponseDto,
  BulkPaymentLinkRowErrorDto,
} from './dto/bulk-payment-link.dto';
import { LinkMetadataRequestDto } from '../dto';
import { LinkValidationError } from './errors';
import { v4 as uuidv4 } from 'uuid';

interface ParsedCsvResult {
  items: BulkPaymentLinkItemDto[];
  /** Original 1-indexed file row (header = row 1) for each entry in `items`, same order. */
  rowNumbers: number[];
  /** Rows that failed structural/format checks before they ever became an item. */
  rowErrors: BulkPaymentLinkRowErrorDto[];
}

@Injectable()
export class BulkPaymentLinksService {
  private readonly logger = new Logger(BulkPaymentLinksService.name);
  private readonly MAX_LINKS_PER_REQUEST = 500;

  constructor(
    private readonly linksService: LinksService,
    private readonly featureFlagsService: FeatureFlagsService,
  ) {}

  /**
   * Generate multiple payment links in bulk from JSON array
   * @param items - Array of payment link items
   * @returns Bulk response with all generated links
   */
  async generateBulkLinks(
    items: BulkPaymentLinkItemDto[],
    options?: {
      /** Original 1-indexed source row per item (e.g. CSV file line). Defaults to the item's 1-indexed array position. */
      rowNumbers?: number[];
      /** Row-level errors already known before generation (e.g. CSV structural issues), merged into the response. */
      precedingRowErrors?: BulkPaymentLinkRowErrorDto[];
    },
  ): Promise<BulkPaymentLinkResponseDto> {
    await this.featureFlagsService.assertActionEnabled('bulk_link_generation');
    const startTime = Date.now();
    const precedingRowErrors = options?.precedingRowErrors ?? [];

    // Validate batch size
    if (items.length === 0 && precedingRowErrors.length === 0) {
      throw new BadRequestException('At least one payment link item is required');
    }

    if (items.length > this.MAX_LINKS_PER_REQUEST) {
      throw new BadRequestException(
        `Maximum ${this.MAX_LINKS_PER_REQUEST} links per request. Received: ${items.length}`,
      );
    }

    this.logger.log(`Generating ${items.length} payment links in bulk`);

    const rowNumbers = options?.rowNumbers ?? items.map((_, idx) => idx + 1);

    // Process all links in parallel with concurrency control
    const results: BulkPaymentLinkResponseItemDto[] = [];
    const rejected: BulkPaymentLinkRowErrorDto[] = [...precedingRowErrors];

    // Process in batches of 50 to avoid overwhelming the system
    const batchSize = 50;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const batchPromises = batch.map(async (item, batchIndex) => {
        const index = i + batchIndex;
        const row = rowNumbers[index] ?? index + 1;
        try {
          const link = await this.generateSingleLink(item, index);
          return { success: true as const, link };
        } catch (error) {
          return { success: false as const, rowError: this.toRowError(row, error) };
        }
      });

      const batchResults = await Promise.all(batchPromises);

      for (const result of batchResults) {
        if (result.success) {
          results.push(result.link);
        } else {
          rejected.push(result.rowError);
        }
      }
    }

    rejected.sort((a, b) => a.row - b.row);

    const processingTime = Date.now() - startTime;

    this.logger.log(
      `Generated ${results.length} payment links, rejected ${rejected.length} row(s) in ${processingTime}ms`,
    );

    return {
      success: rejected.length === 0,
      total: results.length,
      links: results,
      rejected,
      processingTimeMs: processingTime,
    };
  }

  /**
   * Map a thrown error to a stable per-row error code and field. Falls back
   * to a generic code when the failure didn't come from link validation
   * (e.g. an unexpected downstream error).
   */
  private toRowError(row: number, error: unknown): BulkPaymentLinkRowErrorDto {
    if (error instanceof LinkValidationError) {
      return {
        row,
        field: error.field ?? 'unknown',
        code: error.code,
        message: error.message,
      };
    }

    return {
      row,
      field: 'unknown',
      code: 'LINK_GENERATION_FAILED',
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  /**
   * Parse CSV content and generate payment links
   * @param csvContent - CSV string with headers
   * @returns Bulk response with all generated links
   */
  async generateFromCSV(csvContent: string): Promise<BulkPaymentLinkResponseDto> {
    this.logger.log('Parsing CSV for bulk payment link generation');

    // Parse CSV
    const { items, rowNumbers, rowErrors } = this.parseCSV(csvContent);

    this.logger.log(
      `Parsed ${items.length} valid item(s) and ${rowErrors.length} rejected row(s) from CSV`,
    );

    // Generate links for the valid rows, carrying the CSV-level rejections through
    // so a single bad row never discards the rows that parsed and generated fine.
    return this.generateBulkLinks(items, { rowNumbers, precedingRowErrors: rowErrors });
  }

  /**
   * Generate a single payment link
   * @param item - Payment link item
   * @param index - Index in the batch
   * @returns Generated link response
   */
  private async generateSingleLink(
    item: BulkPaymentLinkItemDto,
    index: number,
  ): Promise<BulkPaymentLinkResponseItemDto> {
    // Convert to LinkMetadataRequestDto
    const request: LinkMetadataRequestDto = {
      amount: item.amount,
      asset: item.asset,
      memo: item.memo,
      memoType: item.memoType as 'text' | 'id' | 'hash' | 'return',
      username: item.username,
      destination: item.destination,
      referenceId: item.referenceId,
      privacy: item.privacy,
      expirationDays: item.expirationDays,
      acceptedAssets: item.acceptedAssets,
    };

    // Generate metadata using existing service
    const metadata = await this.linksService.generateMetadata(request);

    // Generate unique ID
    const id = `link_${uuidv4().substring(0, 12)}`;

    // Build shareable URL
    const url = `https://app.quickex.to/pay?${metadata.canonical}`;

    return {
      id,
      canonical: metadata.canonical,
      url,
      amount: metadata.amount,
      asset: metadata.asset,
      username: metadata.username || undefined,
      destination: metadata.destination || undefined,
      referenceId: metadata.referenceId || undefined,
      index,
    };
  }

  /**
   * Parse CSV content into payment link items
   * Supports headers: amount, asset, memo, memoType, username, destination, referenceId, privacy, expirationDays, acceptedAssets
   * @param csvContent - CSV string
   * @returns Array of payment link items
   */
  private parseCSV(csvContent: string): ParsedCsvResult {
    const lines = csvContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length < 2) {
      throw new BadRequestException(
        'Upload a CSV file with a header row and at least one invoice row.',
      );
    }

    // Parse headers
    const headers = lines[0]
      .split(',')
      .map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));

    // Validate required header
    if (!headers.includes('amount')) {
      throw new BadRequestException('CSV must contain "amount" column');
    }

    const items: BulkPaymentLinkItemDto[] = [];
    const rowNumbers: number[] = [];
    const rowErrors: BulkPaymentLinkRowErrorDto[] = [];

    // Parse data rows. Row numbers are 1-indexed as in the uploaded file,
    // so the header is row 1 and the first data row is row 2.
    for (let i = 1; i < lines.length; i++) {
      const fileRow = i + 1;
      const values = this.parseCSVLine(lines[i]);

      if (values.length !== headers.length) {
        rowErrors.push({
          row: fileRow,
          field: 'unknown',
          code: 'COLUMN_COUNT_MISMATCH',
          message: `Expected ${headers.length} column(s) but found ${values.length}.`,
        });
        continue;
      }

      // Map CSV row to DTO
      const row: Record<string, string> = {};
      headers.forEach((header, index) => {
        row[header] = values[index];
      });

      const item: BulkPaymentLinkItemDto = {
        amount: parseFloat(row.amount),
      };

      if (row.asset) item.asset = row.asset;
      if (row.memo) item.memo = row.memo;
      if (row.memotype) item.memoType = row.memoType;
      if (row.username) item.username = row.username;
      if (row.destination) item.destination = row.destination;
      if (row.referenceid || row.reference_id) {
        item.referenceId = row.referenceid || row.reference_id;
      }
      if (row.privacy) item.privacy = row.privacy.toLowerCase() === 'true';
      if (row.expirationdays || row.expiration_days) {
        item.expirationDays = parseInt(row.expirationdays || row.expiration_days, 10);
      }
      if (row.acceptedassets || row.accepted_assets) {
        item.acceptedAssets = (row.acceptedassets || row.accepted_assets)
          .split('|')
          .map((a) => a.trim())
          .filter((a) => a.length > 0);
      }

      // Validate amount
      if (isNaN(item.amount) || item.amount <= 0) {
        rowErrors.push({
          row: fileRow,
          field: 'amount',
          code: 'INVALID_AMOUNT',
          message: `"${row.amount}" is not a valid positive amount.`,
        });
        continue;
      }

      items.push(item);
      rowNumbers.push(fileRow);
    }

    return { items, rowNumbers, rowErrors };
  }

  /**
   * Parse a single CSV line, handling quoted values
   * @param line - CSV line
   * @returns Array of values
   */
  private parseCSVLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];

      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    values.push(current.trim());
    return values;
  }
}
